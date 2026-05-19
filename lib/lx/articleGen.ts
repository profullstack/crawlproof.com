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
  user_id: string;
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

const INLINE_IMAGE_COUNT = 3;
const MAX_PRIOR_ARTICLE_LINKS = 3;

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
  // 5,000-22,000 chars ≈ 1,000-3,300 words. Without an upper bound Claude
  // occasionally produces 70k+ chars, which can't be parsed back as JSON
  // inside max_tokens. The cap is the hard rail; the system prompt asks
  // for 2,200-3,200 words.
  markdown_body: z.string().min(5000).max(22000),
  used_internal_link_urls: z.array(z.string().url()).max(8),
  // Inline-image slots placed at section boundaries inside markdown_body
  // as `<!--INLINE_IMAGE_N-->` markers (N = 1..INLINE_IMAGE_COUNT). Each
  // entry supplies the alt text + an image-generation prompt; we render
  // them after the article body is back and substitute the markers with
  // `![alt](url)` before HTML conversion.
  inline_image_prompts: z
    .array(
      z.object({
        alt: z.string().min(5).max(200),
        prompt: z.string().min(20).max(500),
      }),
    )
    .min(INLINE_IMAGE_COUNT)
    .max(INLINE_IMAGE_COUNT),
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
    "Length: STRICTLY 2,200–3,200 words. Hard cap on markdown_body is ~22,000 characters — outputs over that are rejected. Prioritize depth and usefulness over word count, and edit ruthlessly to stay within the bound.",
    "",
    "Internal links: insert each provided URL inline exactly once as a standard markdown `[anchor](url)` link where the surrounding sentence is genuinely about that URL's topic. Never create a \"Further reading\" list. Never invent URLs — use only those provided. Link candidates may include both site pages AND prior blog posts on this same site — treat both the same way (inline contextual anchor; the prior posts are clearly labeled in the candidate list).",
    "",
    `Inline images: place exactly ${INLINE_IMAGE_COUNT} placeholder lines of the form '<!--INLINE_IMAGE_1-->', '<!--INLINE_IMAGE_2-->', '<!--INLINE_IMAGE_3-->' (each on its own line, in numeric order) inside markdown_body. Place each marker on a blank line immediately after a major H2 boundary, distributed across the body — never inside the intro, the TOC, a blockquote, a table, or inside the final '### Try {brand}' CTA block. In inline_image_prompts return exactly ${INLINE_IMAGE_COUNT} objects in the same 1→${INLINE_IMAGE_COUNT} order: each with a short alt text describing what the image shows for accessibility, and an image generation prompt for that section's topic (abstract editorial style, no text/typography/logos/people).`,
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

type LabeledCandidate = LinkCandidate & { kind: "site_page" | "prior_post" };

function buildUserPrompt(input: {
  site: SiteRow;
  keyword: string;
  candidates: LabeledCandidate[];
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
        `${i + 1}. [${c.kind === "prior_post" ? "PRIOR POST" : "SITE PAGE"}] ${c.url}\n   Title: ${c.title ?? "(untitled)"}\n   About: ${
          c.description ?? "(no description)"
        }`,
    )
    .join("\n");
  const linkSlotLine = linkSlots > 0
    ? `Insert EXACTLY ${linkSlots} of the following internal links inline as standard markdown links, where each fits naturally in the surrounding sentence. Pick the ${linkSlots} most relevant — do not include the others. Do not invent additional URLs. PRIOR POST candidates are previously published articles on this same blog; linking back to them is preferred when their topic is genuinely adjacent.`
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
  opts: { manual?: boolean } = {},
): Promise<KeywordRow | null> {
  // The cron loop respects scheduled_for so it produces one post per due
  // slot. Manual "Generate now" / "Preview next post" clicks intentionally
  // bypass that filter — otherwise the button silently no-ops whenever the
  // earliest queued slot is in the future.
  let q = supabase
    .from("lx_keyword")
    .select("id, keyword, scheduled_for")
    .eq("site_id", siteId)
    .eq("status", "queued");
  if (!opts.manual) {
    const today = new Date().toISOString().slice(0, 10);
    q = q.lte("scheduled_for", today);
  }
  const { data } = await q
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

// Find previously-generated articles on the same site to backlink into the
// current post. No embedding column on lx_article, so we use token-overlap
// scoring on (title + meta_description + tags) vs (current keyword + niche).
// Cheap, deterministic, and good enough until the article volume grows
// enough to justify on-write embeddings.
async function findPriorArticles(
  supabase: SupabaseClient<any>,
  siteId: string,
  blogRootUrl: string,
  currentKeyword: string,
  niche: string | null,
): Promise<LinkCandidate[]> {
  const { data: rows } = await supabase
    .from("lx_article")
    .select("id, title, slug, meta_description, tags")
    .eq("site_id", siteId)
    .in("status", ["ready", "published"])
    .order("created_at", { ascending: false })
    .limit(100);
  if (!rows || rows.length === 0) return [];

  const tokenize = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4),
    );
  const queryTokens = tokenize(`${currentKeyword} ${niche ?? ""}`);
  if (queryTokens.size === 0) return [];

  type Scored = {
    row: { id: string; title: string; slug: string; meta_description: string; tags: string[] };
    score: number;
  };
  const scored: Scored[] = (rows as Scored["row"][])
    .map((r) => {
      const tokens = tokenize(
        `${r.title} ${r.meta_description ?? ""} ${(r.tags ?? []).join(" ")}`,
      );
      let score = 0;
      for (const t of queryTokens) if (tokens.has(t)) score++;
      return { row: r, score };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);

  const base = blogRootUrl.replace(/\/$/, "");
  return scored.slice(0, MAX_PRIOR_ARTICLE_LINKS).map(({ row }) => ({
    id: row.id,
    url: `${base}/${row.slug}`,
    title: row.title,
    description: row.meta_description,
    distance: 0,
  }));
}

// Generate a thematic inline image. Same style guardrails as the hero
// image, but the prompt describes a specific section topic rather than
// the article as a whole.
async function generateInlineImage(
  openai: OpenAI,
  promptText: string,
  nicheHint: string | null,
): Promise<Buffer | null> {
  const prompt = [
    `Editorial illustration for a section of a long-form technical SEO blog post.`,
    `Section topic: ${promptText}`,
    nicheHint ? `Subject area: ${nicheHint}.` : "",
    "Audience: engineers, operators, technical buyers.",
    "Style: editorial, architectural, minimal. Restrained dark palette with one accent color. Abstract geometric composition (flows, nodes, layers) implying a system, workflow, or infrastructure concept.",
    "Strictly NO text or typography of any kind. NO UI screenshots, NO logos, NO charts with labels, NO people, NO stock-photo office scenes.",
    "3:2 aspect, slightly less cinematic than the hero — feels like a chapter divider.",
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
  opts: { manual?: boolean } = {},
): Promise<GenerateArticleResult> {
  const { supabase, openai, anthropic } = deps;

  const { data: site } = await supabase
    .from("lx_site")
    .select(
      "id, user_id, domain, blog_root_url, niche, target_audiences, description, internal_links_per_article, status",
    )
    .eq("id", siteId)
    .maybeSingle();
  if (!site) return { ok: false, error: "site not found" };
  if (site.status !== "active") return { ok: false, error: `site is ${site.status}` };
  const typedSite = site as SiteRow & { status: string };

  const keyword = await pickKeyword(supabase, siteId, { manual: opts.manual });
  if (!keyword) return { ok: true, skipped: "no-queued-keyword" };

  const claimed = await claimKeyword(supabase, keyword.id);
  if (!claimed) return { ok: true, skipped: "claim-race" };

  // Gate generation behind a credit deduction. Atomic at the SQL layer
  // (consume_credit RPC) so two parallel generations can't both succeed
  // when only one credit is left. Refunded on any downstream failure.
  const { data: hasCredit } = await supabase.rpc("consume_credit", {
    p_owner: typedSite.user_id,
    p_count: 1,
  });
  if (!hasCredit) {
    // Return the claim — the keyword can run later once credits exist.
    await supabase
      .from("lx_keyword")
      .update({ status: "queued" })
      .eq("id", keyword.id);
    return { ok: false, error: "out of credits" };
  }

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
    await refundCredit(supabase, typedSite.user_id);
    return { ok: false, error: "embedding failed" };
  }

  // Configured site-page links plus up to MAX_PRIOR_ARTICLE_LINKS extra
  // slots when prior posts on this blog are topically adjacent. Combined
  // total is capped at MAX_LINK_CANDIDATES so the prompt doesn't bloat.
  const sitePageSlots = Math.min(
    typedSite.internal_links_per_article,
    MAX_LINK_CANDIDATES,
  );
  let candidates: LabeledCandidate[] = [];
  if (sitePageSlots > 0) {
    const { data: rpcRows, error: rpcErr } = await supabase.rpc(
      "lx_find_internal_links",
      {
        p_site_id: typedSite.id,
        p_query_embedding: queryEmbedding,
        p_limit: sitePageSlots * 2, // overfetch so the LLM has options
        p_is_blog_post: false,
      },
    );
    if (rpcErr) console.warn("[lx] internal-link rpc failed", rpcErr.message);
    candidates = ((rpcRows as LinkCandidate[] | null) ?? []).map((c) => ({
      ...c,
      kind: "site_page" as const,
    }));
  }

  // Backlinks to previously-generated articles on this same site. These
  // raise topical authority over time as the blog accumulates posts.
  const priorArticles = await findPriorArticles(
    supabase,
    typedSite.id,
    typedSite.blog_root_url,
    keyword.keyword,
    typedSite.niche,
  );
  const labeledPriors: LabeledCandidate[] = priorArticles.map((c) => ({
    ...c,
    kind: "prior_post" as const,
  }));
  candidates = [...candidates, ...labeledPriors].slice(0, MAX_LINK_CANDIDATES);
  const linkSlots = Math.min(candidates.length, MAX_LINK_CANDIDATES);

  // Generate the article body.
  let article: ArticleOutput;
  try {
    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL,
      // 2,200–3,200 words ≈ ~12k–18k output tokens. JSON escape overhead
      // for markdown (every \n + every " in code blocks gets escaped)
      // can push that another 30%. 32k gives meaningful headroom so the
      // model isn't truncated mid-string — which manifests as
      // "Unterminated string in JSON" on parse.
      max_tokens: 32000,
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
      await refundCredit(supabase, typedSite.user_id);
      return { ok: false, error: "claude empty output" };
    }
    article = response.parsed_output as ArticleOutput;
  } catch (err) {
    await failKeyword(
      supabase,
      keyword.id,
      `claude error: ${err instanceof Error ? err.message : String(err)}`,
    );
    await refundCredit(supabase, typedSite.user_id);
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
    await refundCredit(supabase, typedSite.user_id);
    return { ok: false, error: "internal-link validation failed" };
  }

  // Slugify + dedupe slug.
  const baseSlug = article.slug || slugify(article.title);
  const finalSlug = await uniqueSlug(supabase, typedSite.id, baseSlug);

  // Featured image + inline section images, generated in parallel so the
  // 30–60s image latency stacks once instead of 4×.
  let imageUrl: string | null = null;
  const inlineImageUrls: Array<string | null> = new Array(
    article.inline_image_prompts.length,
  ).fill(null);
  await Promise.all([
    (async () => {
      try {
        const bytes = await generateImage(openai, article.title, typedSite.niche);
        if (bytes)
          imageUrl = await uploadImage(supabase, typedSite.id, finalSlug, bytes);
      } catch (err) {
        console.warn(
          "[lx] hero image generation failed, continuing without",
          err instanceof Error ? err.message : err,
        );
      }
    })(),
    ...article.inline_image_prompts.map(async (p, i) => {
      try {
        const bytes = await generateInlineImage(openai, p.prompt, typedSite.niche);
        if (bytes) {
          inlineImageUrls[i] = await uploadImage(
            supabase,
            typedSite.id,
            `${finalSlug}-inline-${i + 1}`,
            bytes,
          );
        }
      } catch (err) {
        console.warn(
          `[lx] inline image ${i + 1} failed, continuing without`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  ]);

  // Substitute the inline-image markers in markdown. A missing/failed
  // image strips the marker rather than leaving a visible comment.
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

  // Render HTML.
  let html: string;
  try {
    html = await markdownToHtml(bodyWithImages);
  } catch (err) {
    await failKeyword(
      supabase,
      keyword.id,
      `markdown render failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    await refundCredit(supabase, typedSite.user_id);
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
      content_markdown: bodyWithImages,
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
    await refundCredit(supabase, typedSite.user_id);
    return { ok: false, error: insErr?.message ?? "insert failed" };
  }

  // Transition the keyword off 'generating' once the article row exists.
  // 'published' is a misnomer in preview mode (the article is in 'ready'),
  // but it's the terminal status the schema allows and the sweep won't
  // touch it. Without this update the sweep at lxSweep() would eventually
  // reset the keyword to 'queued' and produce duplicate articles.
  await supabase
    .from("lx_keyword")
    .update({ article_id: inserted.id, status: "published" })
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

// Bump the user's credit balance back by 1 — called when generation was
// gated by consume_credit but then failed before producing an article.
// Best-effort: if the balance read or update fails, we log and move on
// rather than retry-loop. The cost is one wasted credit, not corruption.
async function refundCredit(
  supabase: SupabaseClient<any>,
  ownerId: string,
): Promise<void> {
  const { data: prof, error: readErr } = await supabase
    .from("profiles")
    .select("credits_balance")
    .eq("id", ownerId)
    .maybeSingle();
  if (readErr || !prof) {
    console.warn(`[lx] credit refund: profile read failed`, readErr?.message);
    return;
  }
  const { error: updErr } = await supabase
    .from("profiles")
    .update({ credits_balance: (prof.credits_balance ?? 0) + 1 })
    .eq("id", ownerId);
  if (updErr) {
    console.warn(`[lx] credit refund update failed`, updErr.message);
  }
}
