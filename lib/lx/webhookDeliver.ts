// Webhook delivery for autoblog articles (PRD §7).
//
// Reads one lx_article (status='ready') + its owning lx_site, maps it
// to the normalized `Post` shape, and hands the actual HTTP work off
// to @profullstack/autoblog. The SDK emits CloudEvents 1.0 envelopes
// signed with Standard Webhooks headers and handles retry policy
// (0s / 10s / 60s, retry on 5xx/408/429/network, give up on 4xx).
//
// This function still owns the DB orchestration around delivery: the
// atomic ready→publishing claim, the published/failed terminal write,
// and the keyword status bump. The wire shape and transport live in
// the SDK so all four Profullstack consumers share one definition.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildEvent, sendWebhook, type Post } from "@profullstack/autoblog";
import { env } from "../env";
import { findExchangeCandidates } from "./exchangeMatcher";
import { buildNetworkBlock } from "./networkBlock";

type ArticleRow = {
  id: string;
  site_id: string;
  title: string;
  slug: string;
  meta_description: string;
  excerpt: string | null;
  content_markdown: string;
  content_html: string;
  image_url: string | null;
  tags: string[];
  outbound_links: Array<{ url: string; anchor: string }>;
  internal_links: Array<{ url: string; title: string }>;
  status: string;
  webhook_delivery_id: string | null;
  webhook_attempts: number;
  created_at: string;
  published_at: string | null;
  updated_at: string | null;
};

type SiteRow = {
  id: string;
  domain: string;
  blog_root_url: string;
  webhook_url: string | null;
  webhook_secret: string | null;
  author_name: string | null;
  author_url: string | null;
  // Network opt-in, resolved for the site that will HOST the post. For a guest
  // post that is the partner, not the author: it is the host's readers who see
  // the ad unit and the host's owner who agreed to carry it.
  project_id: string;
  user_id: string;
  niche: string | null;
  ads_enabled: boolean | null;
};

/**
 * BlogPosting JSON-LD prepended to the delivered HTML.
 *
 * crawlproof's own audit marks a site down for shipping articles without an
 * author, a published date, or Article markup (see content.author,
 * content.date_signal, and the schema recommendations in lib/audit). Until now
 * the autoblog delivered exactly that: no byline, no dates in the body, no
 * structured data — so our own product handed customers content that our own
 * report would then flag on their domain.
 *
 * Emitting the markup inside `html` rather than as a new payload field is
 * deliberate: the CloudEvents `Post` shape is shared by four Profullstack
 * consumers and adding a field means every receiver has to learn it, whereas
 * a receiver that already renders `html` picks this up with no change at all.
 */
export function buildArticleJsonLd(input: {
  url: string;
  title: string;
  description: string;
  imageUrl: string | null;
  publishedAt: string;
  updatedAt: string;
  authorName: string | null;
  authorUrl: string | null;
  publisherName: string;
  tags: string[];
}): string {
  const author = input.authorName
    ? {
        "@type": "Person",
        name: input.authorName,
        ...(input.authorUrl ? { url: input.authorUrl, sameAs: [input.authorUrl] } : {}),
      }
    : { "@type": "Organization", name: input.publisherName };

  const payload = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: input.title,
    description: input.description,
    mainEntityOfPage: { "@type": "WebPage", "@id": input.url },
    url: input.url,
    datePublished: input.publishedAt,
    dateModified: input.updatedAt,
    author,
    publisher: { "@type": "Organization", name: input.publisherName },
    ...(input.imageUrl ? { image: [input.imageUrl] } : {}),
    ...(input.tags.length > 0 ? { keywords: input.tags.join(", ") } : {}),
  };

  // JSON inside a <script> must not be able to close the tag early.
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

export type DeliveryResult = {
  ok: boolean;
  status: "published" | "failed";
  responseCode: number | null;
  attempts: number;
  error?: string;
};

function articleToPost(article: ArticleRow, site: SiteRow, networkHtml = ""): Post {
  const blogRoot = site.blog_root_url.replace(/\/$/, "");
  const url = `${blogRoot}/${article.slug}`;

  // Dates come from the row, not from `now()`. Stamping both fields with the
  // delivery time meant every retry moved the article's publication date, and
  // a redelivered post looked freshly written to anything reading the feed.
  const now = new Date().toISOString();
  const publishedAt = article.published_at ?? article.created_at ?? now;
  const updatedAt = article.updated_at ?? publishedAt;

  const jsonLd = buildArticleJsonLd({
    url,
    title: article.title,
    description: article.excerpt || article.meta_description || "",
    imageUrl: article.image_url,
    publishedAt,
    updatedAt,
    authorName: site.author_name,
    authorUrl: site.author_url,
    publisherName: site.domain,
    tags: article.tags ?? [],
  });

  return {
    id: article.id,
    url,
    canonical_url: url,
    title: article.title,
    slug: article.slug,
    excerpt: article.excerpt || article.meta_description || null,
    // The network block goes after the article and outside the JSON-LD, so an
    // ad unit and a list of other people's links are never described to a
    // crawler as part of this article's body.
    html: [jsonLd, article.content_html, networkHtml].filter(Boolean).join("\n"),
    // Markdown deliberately does NOT carry the block. A receiver rendering the
    // markdown path would have to trust our HTML through its own sanitiser,
    // and the ad unit needs a script tag that no markdown renderer will emit.
    markdown: article.content_markdown,
    status: "published",
    published_at: publishedAt,
    updated_at: updatedAt,
    author: site.author_name
      ? { name: site.author_name, ...(site.author_url ? { url: site.author_url } : {}) }
      : null,
    tags: article.tags ?? [],
    categories: [],
    featured_image: article.image_url ? { url: article.image_url } : null,
  };
}

export async function deliverArticle(
  articleId: string,
  deps: { supabase: SupabaseClient<any> },
): Promise<DeliveryResult> {
  const { supabase } = deps;

  // Atomic claim: only flip ready -> publishing once.
  const { data: claimed } = await supabase
    .from("lx_article")
    .update({ status: "publishing" })
    .eq("id", articleId)
    .eq("status", "ready")
    .select(
      "id, site_id, target_site_id, is_guest_post, title, slug, meta_description, excerpt, content_markdown, content_html, image_url, tags, outbound_links, internal_links, status, webhook_delivery_id, webhook_attempts, created_at, published_at, updated_at",
    )
    .maybeSingle<ArticleRow & { target_site_id: string | null; is_guest_post: boolean | null }>();
  if (!claimed) {
    return {
      ok: false,
      status: "failed",
      responseCode: null,
      attempts: 0,
      error: "article not in 'ready' state",
    };
  }

  // For guest posts, the receiver is target_site_id (the partner blog
  // that will host the post), not site_id (the author who wrote it).
  // Fetch webhook config from whichever the row points us at.
  const deliveryTargetId = claimed.target_site_id ?? claimed.site_id;
  const { data: site } = await supabase
    .from("lx_site")
    .select(
      "id, domain, blog_root_url, webhook_url, webhook_secret, author_name, author_url, project_id, user_id, niche, ads_enabled",
    )
    .eq("id", deliveryTargetId)
    .maybeSingle<SiteRow>();
  if (!site?.webhook_url || !site?.webhook_secret) {
    await supabase
      .from("lx_article")
      .update({
        status: "failed",
        webhook_last_error: "webhook not configured",
      })
      .eq("id", articleId);
    return {
      ok: false,
      status: "failed",
      responseCode: null,
      attempts: 0,
      error: "webhook not configured",
    };
  }

  // Ads and partner links for the hosting site, if it is in the network.
  //
  // Built here rather than at generation time because the host is only known
  // once the guest-post target has been resolved, and because a redelivery
  // should carry a current block rather than one frozen weeks ago. The whole
  // thing is best-effort: `buildNetworkBlock` swallows its own failures, and
  // this catch covers the rest, because an article that publishes without an
  // ad has cost an impression while an article that fails to publish has cost
  // the customer the thing they pay for.
  const partnerLinks = await findExchangeCandidates(supabase, {
    selfSiteId: site.id,
    selfNiche: site.niche,
    keyword: (claimed.tags ?? []).join(" ") || claimed.title,
    slots: 3,
  })
    .then((r) =>
      r.candidates.map((c) => ({
        title: c.title,
        url: c.url,
        source: "partner" as const,
      })),
    )
    .catch(() => []);

  const networkHtml = await buildNetworkBlock(
    supabase,
    site,
    claimed.tags ?? [],
    partnerLinks,
    env.siteUrl,
  ).catch((err: unknown) => {
    console.warn("[lx] network block failed:", err);
    return "";
  });

  const post = articleToPost(claimed, site, networkHtml);
  // Reuse the saved delivery id on retries so receivers idempotently
  // dedupe. SDK uses event.id as the webhook-id header.
  const event = buildEvent(post, {
    source: env.siteUrl,
    eventId: claimed.webhook_delivery_id ?? undefined,
  });

  let responseBody = "";
  const result = await sendWebhook(site.webhook_url, event, {
    secret: site.webhook_secret,
    fetchImpl: async (url, init) => {
      const res = await fetch(url, init);
      if (!res.ok) {
        responseBody = await res
          .clone()
          .text()
          .then((s) => s.slice(0, 1000))
          .catch(() => "");
      }
      return res;
    },
  });

  if (result.ok) {
    await supabase
      .from("lx_article")
      .update({
        status: "published",
        // Same value we put in the payload and the JSON-LD, so the row and
        // the receiver never disagree about when this post was published.
        published_at: post.published_at,
        webhook_delivery_id: event.id,
        webhook_response_code: result.status,
        webhook_attempts: result.attempts,
        webhook_last_error: null,
      })
      .eq("id", articleId);
    await supabase
      .from("lx_keyword")
      .update({ status: "published" })
      .eq("article_id", articleId);
    return {
      ok: true,
      status: "published",
      responseCode: result.status,
      attempts: result.attempts,
    };
  }

  await supabase
    .from("lx_article")
    .update({
      status: "failed",
      webhook_delivery_id: event.id,
      webhook_response_code: result.status,
      webhook_attempts: result.attempts,
      webhook_last_error:
        responseBody ||
        result.error ||
        (result.status !== null ? `HTTP ${result.status}` : "unknown error"),
    })
    .eq("id", articleId);
  await supabase
    .from("lx_keyword")
    .update({ status: "failed" })
    .eq("article_id", articleId);

  return {
    ok: false,
    status: "failed",
    responseCode: result.status,
    attempts: result.attempts,
    error: result.error ?? `HTTP ${result.status}`,
  };
}
