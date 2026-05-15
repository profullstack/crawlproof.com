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
};

type SiteRow = {
  id: string;
  domain: string;
  blog_root_url: string;
  webhook_url: string | null;
  webhook_secret: string | null;
};

export type DeliveryResult = {
  ok: boolean;
  status: "published" | "failed";
  responseCode: number | null;
  attempts: number;
  error?: string;
};

function articleToPost(article: ArticleRow, site: SiteRow): Post {
  const blogRoot = site.blog_root_url.replace(/\/$/, "");
  const url = `${blogRoot}/${article.slug}`;
  return {
    id: article.id,
    url,
    canonical_url: url,
    title: article.title,
    slug: article.slug,
    excerpt: article.excerpt || article.meta_description || null,
    html: article.content_html,
    markdown: article.content_markdown,
    status: "published",
    published_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    author: null,
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
      "id, site_id, title, slug, meta_description, excerpt, content_markdown, content_html, image_url, tags, outbound_links, internal_links, status, webhook_delivery_id, webhook_attempts, created_at",
    )
    .maybeSingle<ArticleRow>();
  if (!claimed) {
    return {
      ok: false,
      status: "failed",
      responseCode: null,
      attempts: 0,
      error: "article not in 'ready' state",
    };
  }

  const { data: site } = await supabase
    .from("lx_site")
    .select("id, domain, blog_root_url, webhook_url, webhook_secret")
    .eq("id", claimed.site_id)
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

  const post = articleToPost(claimed, site);
  // Reuse the saved delivery id on retries so receivers idempotently
  // dedupe. SDK uses event.id as the webhook-id header.
  const event = buildEvent(post, {
    source: env.siteUrl,
    eventId: claimed.webhook_delivery_id ?? undefined,
  });

  const result = await sendWebhook(site.webhook_url, event, {
    secret: site.webhook_secret,
  });

  if (result.ok) {
    await supabase
      .from("lx_article")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
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
        result.error ?? (result.status !== null ? `HTTP ${result.status}` : "unknown error"),
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
