// Autoblog article generation pipeline (PRD §6).
//
// One call = one article for one site:
//   1. Pick the next queued keyword (scheduled_for <= today).
//   2. Embed the keyword + site context.
//   3. Pull top-N internal-link candidates via lx_find_internal_links RPC.
//   4. Call Claude Sonnet 4.6 with the keyword, site profile, and link
//      slots to fill. Output is structured JSON (zod-validated).
//   5. Generate the featured image with gpt-image-1, upload it to the
//      lx-article-images public bucket.
//   6. Render markdown → HTML with marked.
//   7. Insert the lx_article row at status='ready'; mark the keyword
//      as article-bound. Webhook delivery is a separate job.

import type { SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
// The SDK's zod helper imports from "zod/v4" internally and calls
// z.toJSONSchema() — a v4-only API. Importing plain "zod" gives v3
// schemas whose `_def` shape v4 can't read.
import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { markdownToHtml } from "../markdown";

const EMBED_MODEL = "text-embedding-3-small";
const CLAUDE_MODEL = "claude-sonnet-4-6";
const IMAGE_MODEL = "gpt-image-1";
const IMAGE_SIZE = "1536x1024";
const BUCKET = "lx-article-images";

// Cap on input to the LLM so a malicious or oversized sitemap can't
// blow up the prompt.
const MAX_LINK_CANDIDATES = 8;

type SiteRow = {
  id: string;
  domain: string;
  blog_root_url: string;
  niche: string | null;
  target_audiences: string[];
  description: string;
  internal_links_per_article: number;
};

type KeywordRow = {
  id: string;
  keyword: string;
  scheduled_for: string;
};

type LinkCandidate = {
  id: string;
  url: string;
  title: string | null;
  description: string | null;
  distance: number;
};

const ArticleSchema = z.object({
  title: z.string().min(10).max(180),
  slug: z
    .string()
    .min(3)
    .max(96)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase-kebab-case"),
  meta_description: z.string().min(50).max(160),
  excerpt: z.string().min(50).max(240),
  tags: z.array(z.string().min(2).max(40)).min(5).max(8),
  markdown_body: z.string().min(5000),
  used_internal_link_urls: z.array(z.string().url()).max(8),
});

type ArticleOutput = z.infer<typeof ArticleSchema>;

export function slugify(input: string, max = 80): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

function buildSystemPrompt(): string {
  return [
    "You are writing a long-form SEO blog post in the practical, operator-focused style of ThreatCrush and CoinPayPortal: pragmatic B2B/technical voice, strong opening pain point, the topic reframed as an architecture/workflow problem (not a definition), table of contents, H2/H3 sections, practical rules in blockquotes, bullets/tables, implementation advice, soft product CTA near the end.",
    "",
    "Voice:",
    "- Direct, confident, technical but readable, slightly skeptical of hype.",
    "- Pragmatic founder/operator explaining a real workflow problem, not a generic SEO writer.",
    "- Open with a concrete pain point in 2–4 short paragraphs.",
    "- Use the pattern: \"Teams think the problem is X. The real problem is Y.\"",
    "- Use phrases like: \"The mistake teams make is…\" / \"That changes the conversation.\" / \"The practical question is…\" / \"A useful way to think about it is…\" / \"What breaks in practice is…\"",
    "- Avoid fluff, motivational language, generic marketing claims, emoji clutter, academic tone.",
    "- Do not invent stats or citations. If sources are provided, weave them naturally. If not, hedge (\"many teams\", \"in production\").",
    "",
    "Structure for markdown_body (do NOT include front matter / a leading H1 — title goes in the title field):",
    "- Intro: real-world problem, why now, reframe the keyword as an architecture/workflow/business decision.",
    "- Table of Contents: markdown links to 6–8 H2 sections (each with 1–3 H3 subsections beneath when sensible).",
    "- Body sections: each H2 makes one strong point; each H3 answers a practical sub-question.",
    "- Include at least 3 blockquotes formatted `> Practical rule: …`.",
    "- Include at least one comparison table.",
    "- Include at least one numbered workflow / implementation sequence.",
    "- Discuss common failure modes and what breaks when teams implement the topic badly.",
    "- Where useful, include explicit \"what works\" and \"what fails\" sections.",
    "- Near the end, a product-fit section connecting the topic to the brand — useful and architectural, not salesy.",
    "- Final CTA: a horizontal rule, then a short `### Try {brand}` block with the brand one-liner and a markdown link.",
    "",
    "Content patterns:",
    "- Security/CTEM/SOC topics: signals, workflows, detection, automation, integration, ownership, response, validation, operational context. Emphasize reducing noise, shortening investigation time, connecting proactive and reactive work, avoiding disconnected tooling.",
    "- Payments/API/crypto topics: checkout architecture, APIs, webhooks, reconciliation, custody boundaries, escrow, settlement, rate limits, retries, idempotency, merchant operations. Emphasize that the UI is not the whole system — state, trust, settlement, and support are the real work.",
    "",
    "SEO requirements:",
    "- Use the topic naturally in the H1, the first 100 words, at least 2 H2 headings, and the closing.",
    "- Use secondary keywords naturally; never stuff.",
    "- Include semantic variations.",
    "- meta_description: ≤160 characters.",
    "- excerpt: ≤240 characters.",
    "- 5–8 lowercase tags related to the topic.",
    "",
    "Length: 2,200–3,200 words. Prioritize depth and usefulness over word count.",
    "",
    "Internal links: insert each provided URL inline exactly once as a standard markdown `[anchor](url)` link where the surrounding sentence is genuinely about that URL's topic. Never create a \"Further reading\" list. Never invent URLs — use only those provided.",
    "",
    "Output: strict JSON matching the schema. The markdown_body is the article body only.",
  ].join("\n");
}

function brandOneLiner(site: SiteRow): string {
  // First sentence of the site's description, capped — gives the LLM a
  // crisp one-liner to use in the final CTA without us guessing.
  const desc = (site.description ?? "").trim();
  if (!desc) return `${site.domain} — autoblog feed.`;
  const m = desc.match(/^[\s\S]{20,200}?[.!?](?:\s|$)/);
  return (m ? m[0] : desc).trim().slice(0, 200);
}

function buildUserPrompt(input: {
  site: SiteRow;
  keyword: string;
  candidates: LinkCandidate[];
  linkSlots: number;
}): string {
  const { site, keyword, candidates, linkSlots } = input;
  const brand = site.domain;
  const niche = site.niche?.trim() || "B2B / technical SaaS";
  const audiences = site.target_audiences.length
    ? site.target_audiences.join(", ")
    : "technical operators and engineering leads";
  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getUTCFullYear();
  const ctaUrl = `https://${site.domain}`;
  const ctaText = `Try ${brand}`;

  const linkList = candidates
    .slice(0, MAX_LINK_CANDIDATES)
    .map(
      (c, i) =>
        `${i + 1}. ${c.url}\n   Title: ${c.title ?? "(untitled)"}\n   About: ${
          c.description ?? "(no description)"
        }`,
    )
    .join("\n");
  const linkSlotLine = linkSlots > 0
    ? `Insert EXACTLY ${linkSlots} of the following internal links inline as standard markdown links, where each fits naturally in the surrounding sentence. Pick the ${linkSlots} most relevant — do not include the others. Do not invent additional URLs.`
    : "Internal-link slots: 0. Return used_internal_link_urls: [] and do not link out.";

  return [
    "Runtime inputs:",
    `- Site/brand: ${brand}`,
    `- Brand one-liner: ${brandOneLiner(site)}`,
    `- Niche/audience: ${niche}`,
    `- Main topic/keyword: "${keyword}"`,
    `- Target reader: ${audiences}`,
    `- Desired CTA URL/text: ${ctaUrl} / ${ctaText}`,
    `- Current year: ${year}`,
    `- Current date: ${today}`,
    site.description ? `- Site description: ${site.description}` : "",
    "",
    "Internal links to fit naturally inline (do NOT include in a Further Reading list):",
    linkSlotLine,
    "",
    linkList || "(none — return used_internal_link_urls: [])",
    "",
    "Now write the blog post. Return the JSON object only.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function pickKeyword(
  supabase: SupabaseClient<any>,
  siteId: string,
): Promise<KeywordRow | null> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("lx_keyword")
    .select("id, keyword, scheduled_for")
    .eq("site_id", siteId)
    .eq("status", "queued")
    .lte("scheduled_for", today)
    .order("scheduled_for", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as KeywordRow | null) ?? null;
}

async function claimKeyword(
  supabase: SupabaseClient<any>,
  keywordId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("lx_keyword")
    .update({ status: "generating" })
    .eq("id", keywordId)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  return !!data;
}

async function uniqueSlug(
  supabase: SupabaseClient<any>,
  siteId: string,
  base: string,
): Promise<string> {
  let candidate = base;
  for (let i = 0; i < 6; i++) {
    const { data } = await supabase
      .from("lx_article")
      .select("id")
      .eq("site_id", siteId)
      .eq("slug", candidate)
      .maybeSingle();
    if (!data) return candidate;
    candidate = `${base}-${i + 2}`;
  }
  // Unlikely fallback — append a timestamp.
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

async function generateImage(
  openai: OpenAI,
  title: string,
  nicheHint: string | null,
): Promise<Buffer | null> {
  // Hero image for a pragmatic B2B / technical SEO post. Match the
  // tone of the article: operator-focused, architectural, not salesy.
  const prompt = [
    `Hero image for a long-form technical SEO blog post titled: "${title}".`,
    nicheHint ? `Subject area: ${nicheHint}.` : "",
    "Audience: engineers, operators, technical buyers.",
    "Style: editorial, architectural, minimal. Restrained dark palette with one accent color. Abstract geometric composition (flows, nodes, layers) implying a system, workflow, or infrastructure topic.",
    "Strictly NO text or typography of any kind. NO UI screenshots, NO logos, NO charts with labels, NO people, NO stock-photo office scenes.",
    "Cinematic 3:2 hero aspect. Subtle depth, not flat.",
  ]
    .filter(Boolean)
    .join(" ");
  const res = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt,
    size: IMAGE_SIZE,
    n: 1,
  });
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) return null;
  return Buffer.from(b64, "base64");
}

async function uploadImage(
  supabase: SupabaseClient<any>,
  siteId: string,
  slug: string,
  bytes: Buffer,
): Promise<string | null> {
  const path = `${siteId}/${slug}.png`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: "image/png",
    upsert: true,
  });
  if (error) {
    console.warn("[lx] image upload failed", error.message);
    return null;
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export function validateInternalLinks(
  markdown: string,
  expected: string[],
): { ok: true } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  for (const url of expected) {
    if (!markdown.includes(url)) missing.push(url);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

export type GenerateArticleResult = {
  ok: boolean;
  articleId?: string;
  slug?: string;
  error?: string;
  skipped?: "no-queued-keyword" | "claim-race";
};

export async function generateArticle(
  siteId: string,
  deps: {
    supabase: SupabaseClient<any>;
    openai: OpenAI;
    anthropic: Anthropic;
  },
): Promise<GenerateArticleResult> {
  const { supabase, openai, anthropic } = deps;

  const { data: site } = await supabase
    .from("lx_site")
    .select(
      "id, domain, blog_root_url, niche, target_audiences, description, internal_links_per_article, status",
    )
    .eq("id", siteId)
    .maybeSingle();
  if (!site) return { ok: false, error: "site not found" };
  if (site.status !== "active") return { ok: false, error: `site is ${site.status}` };
  const typedSite = site as SiteRow & { status: string };

  const keyword = await pickKeyword(supabase, siteId);
  if (!keyword) return { ok: true, skipped: "no-queued-keyword" };

  const claimed = await claimKeyword(supabase, keyword.id);
  if (!claimed) return { ok: true, skipped: "claim-race" };

  // Find internal links.
  const queryText = [
    keyword.keyword,
    typedSite.description,
    typedSite.target_audiences.length
      ? `Audiences: ${typedSite.target_audiences.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join(". ");
  let queryEmbedding: number[] = [];
  try {
    const emb = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: queryText,
    });
    queryEmbedding = emb.data[0].embedding as number[];
  } catch (err) {
    await failKeyword(
      supabase,
      keyword.id,
      `embedding failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, error: "embedding failed" };
  }

  const linkSlots = Math.min(typedSite.internal_links_per_article, MAX_LINK_CANDIDATES);
  let candidates: LinkCandidate[] = [];
  if (linkSlots > 0) {
    const { data: rpcRows, error: rpcErr } = await supabase.rpc("lx_find_internal_links", {
      p_site_id: typedSite.id,
      p_query_embedding: queryEmbedding,
      p_limit: linkSlots * 2, // overfetch so the LLM has options
      p_is_blog_post: false,
    });
    if (rpcErr) console.warn("[lx] internal-link rpc failed", rpcErr.message);
    candidates = (rpcRows as LinkCandidate[] | null) ?? [];
  }

  // Generate the article body.
  let article: ArticleOutput;
  try {
    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL,
      // 2,200–3,200 words ≈ ~12k–18k output tokens including JSON
      // overhead; give headroom so the model isn't truncated mid-body.
      max_tokens: 24000,
      thinking: { type: "disabled" },
      output_config: {
        effort: "medium",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        format: zodOutputFormat(ArticleSchema as any),
      },
      system: [
        {
          type: "text",
          text: buildSystemPrompt(),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: buildUserPrompt({
            site: typedSite,
            keyword: keyword.keyword,
            candidates,
            linkSlots,
          }),
        },
      ],
    });
    const response = await stream.finalMessage();
    if (!response.parsed_output) {
      await failKeyword(
        supabase,
        keyword.id,
        `claude returned no parsed_output (stop_reason=${response.stop_reason ?? "unknown"})`,
      );
      return { ok: false, error: "claude empty output" };
    }
    article = response.parsed_output as ArticleOutput;
  } catch (err) {
    await failKeyword(
      supabase,
      keyword.id,
      `claude error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, error: "claude error" };
  }

  // Validate that all "used" internal links are actually present in the body.
  const linkCheck = validateInternalLinks(
    article.markdown_body,
    article.used_internal_link_urls,
  );
  if (!linkCheck.ok) {
    await failKeyword(
      supabase,
      keyword.id,
      `claude claimed links not present: ${linkCheck.missing.join(", ")}`,
    );
    return { ok: false, error: "internal-link validation failed" };
  }

  // Slugify + dedupe slug.
  const baseSlug = article.slug || slugify(article.title);
  const finalSlug = await uniqueSlug(supabase, typedSite.id, baseSlug);

  // Featured image.
  let imageUrl: string | null = null;
  try {
    const bytes = await generateImage(openai, article.title, typedSite.niche);
    if (bytes) imageUrl = await uploadImage(supabase, typedSite.id, finalSlug, bytes);
  } catch (err) {
    console.warn(
      "[lx] image generation failed, continuing without",
      err instanceof Error ? err.message : err,
    );
  }

  // Render HTML.
  let html: string;
  try {
    html = await markdownToHtml(article.markdown_body);
  } catch (err) {
    await failKeyword(
      supabase,
      keyword.id,
      `markdown render failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, error: "markdown render failed" };
  }

  // Persist the article.
  const internalLinksPayload = candidates
    .filter((c) => article.used_internal_link_urls.includes(c.url))
    .map((c) => ({ url: c.url, title: c.title ?? "" }));

  const { data: inserted, error: insErr } = await supabase
    .from("lx_article")
    .insert({
      site_id: typedSite.id,
      keyword_id: keyword.id,
      title: article.title,
      slug: finalSlug,
      meta_description: article.meta_description,
      excerpt: article.excerpt,
      content_markdown: article.markdown_body,
      content_html: html,
      image_url: imageUrl,
      tags: article.tags,
      internal_links: internalLinksPayload,
      outbound_links: [], // exchange disabled in v1
      status: "ready",
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    await failKeyword(supabase, keyword.id, `insert failed: ${insErr?.message}`);
    return { ok: false, error: insErr?.message ?? "insert failed" };
  }

  await supabase
    .from("lx_keyword")
    .update({ article_id: inserted.id })
    .eq("id", keyword.id);

  return { ok: true, articleId: inserted.id, slug: finalSlug };
}

async function failKeyword(
  supabase: SupabaseClient<any>,
  keywordId: string,
  reason: string,
): Promise<void> {
  console.warn(`[lx] keyword ${keywordId} failed:`, reason);
  await supabase
    .from("lx_keyword")
    .update({ status: "failed" })
    .eq("id", keywordId);
}
