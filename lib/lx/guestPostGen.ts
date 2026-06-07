// Guest-post generator. Author A writes a post in Target B's voice
// with a contextual backlink to A. The resulting lx_article row is
// owned by Target (site_id = targetSiteId) so delivery routes to
// Target's webhook + the slug uniqueness check works on Target's
// namespace, but author_site_id pins the author so they can audit
// their own outgoing posts and the credit comes from their account.
//
// Differences from generateArticle (own-blog):
//   - Topic comes from the caller, not the keyword queue. No
//     consume_credit RPC on Target — the AUTHOR's credit is what
//     gets burned.
//   - The prompt swaps brand identity to Target's voice but reserves
//     ONE mandatory link slot for the author's homepage, framed as
//     "written by the team at <author>".
//   - Internal-link RPC pool is skipped in v1 — we only enforce the
//     author backlink. Target's pgvector lookup can be added later
//     once we want richer in-body cross-links.
//
// Shares image generation + system prompt + schema + slug helpers
// with articleGen via exports, so the visual/structural style of a
// guest post matches what a Target-native post would look like.

import type { SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { markdownToHtml } from "../markdown";
import {
  ArticleSchema,
  INLINE_IMAGE_COUNT,
  buildSystemPrompt,
  extractSectionForMarker,
  generateImage,
  generateInlineImage,
  normalizeArticleOutput,
  refundCredit,
  ensureTableOfContentsLinks,
  slugify,
  uniqueSlug,
  uploadImage,
  validateInternalLinks,
} from "./articleGen";
import { generateStructuredOutput } from "./backendAi";
import { SCAN_CREDITS } from "@/lib/credits";

const CLAUDE_MODEL = "claude-sonnet-4-6";

type SiteCtx = {
  id: string;
  user_id: string;
  domain: string;
  niche: string | null;
  target_audiences: string[];
  description: string;
  status: string;
  backlinks_enabled: boolean;
};

export type GuestPostInput = {
  authorSiteId: string;
  targetSiteId: string;
  topic: string;
};

export type GuestPostResult = {
  ok: boolean;
  articleId?: string;
  slug?: string;
  error?: string;
};

function buildGuestUserPrompt(input: {
  target: SiteCtx;
  author: SiteCtx;
  topic: string;
}): string {
  const { target, author, topic } = input;
  const brand = target.domain;
  const niche = target.niche?.trim() || "B2B / technical SaaS";
  const audiences = target.target_audiences.length
    ? target.target_audiences.join(", ")
    : "technical operators and engineering leads";
  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getUTCFullYear();
  const ctaUrl = `https://${target.domain}`;
  const ctaText = `Try ${brand}`;
  const authorUrl = `https://${author.domain}`;
  const authorBrand = author.domain;
  const authorOneLiner = (() => {
    const desc = (author.description ?? "").trim();
    if (!desc) return `${author.domain} — partner blog in our network`;
    const m = desc.match(/^[\s\S]{20,200}?[.!?](?:\s|$)/);
    return (m ? m[0] : desc).trim().slice(0, 200);
  })();

  return [
    "Runtime inputs (this is a GUEST POST written for the host blog):",
    `- Host blog/brand: ${brand}`,
    `- Host niche/audience: ${niche}`,
    `- Host audience: ${audiences}`,
    `- Main topic/keyword: "${topic}"`,
    `- Desired CTA URL/text (host's): ${ctaUrl} / ${ctaText}`,
    `- Current year: ${year}`,
    `- Current date: ${today}`,
    target.description ? `- Host site description: ${target.description}` : "",
    "",
    "Guest authorship — REQUIRED:",
    `- This post is written as a guest contribution by the team at ${authorBrand} (${authorOneLiner}).`,
    `- Insert EXACTLY ONE inline markdown link to ${authorUrl} where the surrounding sentence naturally references the authoring team's expertise on this topic. Place it in the body (not the final CTA section), with a natural anchor — e.g., "the team at [${authorBrand}](${authorUrl})", or "a recent piece from [${authorBrand}](${authorUrl})". Do not stack it inside the closing '### Try {brand}' block.`,
    `- Return the author URL in used_internal_link_urls: ["${authorUrl}"].`,
    "- Do NOT invent additional URLs. Do NOT add a Further Reading section.",
    "- used_exchange_link_urls: [].",
    "",
    "Voice: write in the host blog's house voice for the host's audience — the guest authorship is acknowledged once, in the body, and otherwise the post reads like a host post.",
    "",
    "Now write the guest post. Return the JSON object only.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateGuestPost(
  input: GuestPostInput,
  deps: {
    supabase: SupabaseClient<any>;
    openai: OpenAI;
    anthropic?: Anthropic | null;
  },
): Promise<GuestPostResult> {
  const { supabase, openai, anthropic } = deps;
  const { authorSiteId, targetSiteId, topic } = input;

  if (authorSiteId === targetSiteId) {
    return { ok: false, error: "author and target are the same site" };
  }

  const { data: author } = await supabase
    .from("lx_site")
    .select(
      "id, user_id, domain, niche, target_audiences, description, status, backlinks_enabled",
    )
    .eq("id", authorSiteId)
    .maybeSingle<SiteCtx>();
  if (!author) return { ok: false, error: "author site not found" };
  if (author.status !== "active") {
    return { ok: false, error: `author site is ${author.status}` };
  }

  const { data: target } = await supabase
    .from("lx_site")
    .select(
      "id, user_id, domain, niche, target_audiences, description, status, backlinks_enabled, inappropriate_content",
    )
    .eq("id", targetSiteId)
    .maybeSingle<SiteCtx & { inappropriate_content: boolean }>();
  if (!target) return { ok: false, error: "target site not found" };
  if (target.status !== "active") {
    return { ok: false, error: `target site is ${target.status}` };
  }
  if (!target.backlinks_enabled || target.inappropriate_content) {
    return { ok: false, error: "target site is not eligible to receive guest posts" };
  }

  // Burn AUTHOR credits. Atomic RPC matches the own-blog flow.
  const { data: hasCredit } = await supabase.rpc("consume_credit", {
    p_owner: author.user_id,
    p_count: SCAN_CREDITS,
  });
  if (!hasCredit) {
    return { ok: false, error: "out of credits (author)" };
  }

  // Generate the post.
  type ArticleOutput = z.infer<typeof ArticleSchema>;
  let article: ArticleOutput;
  try {
    const generated = await generateStructuredOutput({
      name: "lx_guest_post",
      schema: ArticleSchema,
      system: buildSystemPrompt(),
      user: buildGuestUserPrompt({ target, author, topic }),
      anthropic,
      openai,
      anthropicModel: CLAUDE_MODEL,
      maxTokens: 48000,
      anthropicCacheSystemPrompt: true,
    });
    article = normalizeArticleOutput(generated.output);
  } catch (err) {
    await refundCredit(supabase, author.user_id);
    return {
      ok: false,
      error: `backend AI error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The author backlink must be present in the body.
  const authorUrl = `https://${author.domain}`;
  const linkCheck = validateInternalLinks(article.markdown_body, [authorUrl]);
  if (!linkCheck.ok) {
    await refundCredit(supabase, author.user_id);
    return {
      ok: false,
      error: `model did not place the required author backlink (${authorUrl})`,
    };
  }

  // Slug must be unique on the TARGET site — that's where the post will
  // ultimately live (site_id = targetSiteId).
  const baseSlug = article.slug || slugify(article.title);
  const finalSlug = await uniqueSlug(supabase, target.id, baseSlug);

  // Hero + inline images.
  let imageUrl: string | null = null;
  const inlineImageUrls: Array<string | null> = new Array(
    article.inline_image_prompts.length,
  ).fill(null);
  await Promise.all([
    (async () => {
      try {
        const bytes = await generateImage(openai, {
          title: article.title,
          excerpt: article.excerpt,
          metaDescription: article.meta_description,
          tags: article.tags,
          niche: target.niche,
          audiences: target.target_audiences,
          brand: target.domain ?? null,
        });
        if (bytes) imageUrl = await uploadImage(supabase, target.id, finalSlug, bytes);
      } catch (err) {
        console.warn(
          "[lx] guest hero image failed, continuing without",
          err instanceof Error ? err.message : err,
        );
      }
    })(),
    ...article.inline_image_prompts.map(async (p, i) => {
      try {
        const sectionContext = extractSectionForMarker(article.markdown_body, i + 1);
        const bytes = await generateInlineImage(openai, p.prompt, target.niche, {
          kind: (p as { kind?: string }).kind,
          labels: (p as { labels?: string[] }).labels,
          sectionContext,
        });
        if (bytes) {
          inlineImageUrls[i] = await uploadImage(
            supabase,
            target.id,
            `${finalSlug}-inline-${i + 1}`,
            bytes,
          );
        }
      } catch (err) {
        console.warn(
          `[lx] guest inline image ${i + 1} failed, continuing without`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  ]);

  // Substitute the inline image markers + strip any pandoc heading IDs.
  let bodyWithImages = article.markdown_body;
  for (let i = 0; i < article.inline_image_prompts.length; i++) {
    const marker = new RegExp(`<!--\\s*INLINE_IMAGE_${i + 1}\\s*-->`, "g");
    const url = inlineImageUrls[i];
    const alt = article.inline_image_prompts[i]?.alt ?? "";
    bodyWithImages = bodyWithImages.replace(
      marker,
      url ? `![${alt.replace(/[\[\]]/g, "")}](${url})` : "",
    );
  }
  bodyWithImages = bodyWithImages.replace(
    /^(#{1,6}[^\n]*?)\s*\{#[a-z0-9][a-z0-9-]*\}\s*$/gim,
    "$1",
  );
  bodyWithImages = ensureTableOfContentsLinks(bodyWithImages);

  // Render HTML.
  let html: string;
  try {
    html = await markdownToHtml(bodyWithImages);
  } catch (err) {
    await refundCredit(supabase, author.user_id);
    return {
      ok: false,
      error: `markdown render failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Persist. site_id is the TARGET (where the post lives + slug
  // uniqueness key); author/target site IDs explicit for queries.
  // outbound_links carries the author backlink for the receiver to
  // surface as "guest post by {domain}" if they want.
  const internalLinksPayload = [{ url: authorUrl, title: author.domain }];
  const outboundLinksPayload = [
    { url: authorUrl, anchor: author.domain, site_domain: author.domain, is_guest_attribution: true },
  ];

  const { data: inserted, error: insErr } = await supabase
    .from("lx_article")
    .insert({
      site_id: target.id,
      keyword_id: null,
      is_guest_post: true,
      author_site_id: author.id,
      target_site_id: target.id,
      title: article.title,
      slug: finalSlug,
      meta_description: article.meta_description,
      excerpt: article.excerpt,
      content_markdown: bodyWithImages,
      content_html: html,
      image_url: imageUrl,
      tags: article.tags,
      internal_links: internalLinksPayload,
      outbound_links: outboundLinksPayload,
      status: "ready",
    })
    .select("id")
    .single();

  if (insErr || !inserted) {
    await refundCredit(supabase, author.user_id);
    return { ok: false, error: insErr?.message ?? "insert failed" };
  }

  return { ok: true, articleId: inserted.id, slug: finalSlug };
}

// Exported for unit testing — the pure prompt builder.
export const __test = { buildGuestUserPrompt };
