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
import { z } from "zod";
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
  meta_description: z.string().min(50).max(220),
  tags: z.array(z.string().min(2).max(40)).min(2).max(6),
  markdown_body: z.string().min(800),
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
    "You are a senior SEO content writer producing publication-ready blog posts.",
    "Write in a confident, expert tone — neither breathless marketing copy nor academic dryness.",
    "Aim for 900–1,400 words. Use H2/H3 structure. Open with a one-paragraph hook that previews the answer; do not bury the lede.",
    "Cite concrete examples or numbers when claiming a fact. If you cannot, hedge ('many', 'in our experience') instead of inventing.",
    "Never include a 'Conclusion:' or 'In summary:' heading — close with a forward-looking paragraph instead.",
    "Internal links MUST be inserted inline as standard markdown links `[anchor](url)` where the surrounding sentence is naturally about that URL's topic. Never create a 'Further reading' list.",
    "Do NOT invent URLs. Use only the URLs explicitly provided in the user's message; if none fit a section, omit that link rather than fabricate one.",
    "Return strict JSON matching the schema. The markdown_body must be the article body only — no front matter, no leading title (the title goes in its own field).",
  ].join("\n");
}

function buildUserPrompt(input: {
  site: SiteRow;
  keyword: string;
  candidates: LinkCandidate[];
  linkSlots: number;
}): string {
  const { site, keyword, candidates, linkSlots } = input;
  const audienceLine = site.target_audiences.length
    ? `Audience: ${site.target_audiences.join(", ")}.`
    : "Audience: general technical readers.";
  const nicheLine = site.niche ? `Niche: ${site.niche}.` : "";
  const linkList = candidates
    .slice(0, MAX_LINK_CANDIDATES)
    .map(
      (c, i) =>
        `${i + 1}. ${c.url}\n   Title: ${c.title ?? "(untitled)"}\n   About: ${
          c.description ?? "(no description)"
        }`,
    )
    .join("\n");

  return [
    `Write a blog post for ${site.domain}.`,
    `Topic / target keyword: "${keyword}".`,
    nicheLine,
    audienceLine,
    site.description ? `Site description: ${site.description}` : "",
    "",
    `You MUST insert exactly ${linkSlots} of the following internal links, inline as markdown links, where each fits naturally. Pick the ${linkSlots} most relevant — do not include the others. Do not invent additional URLs.`,
    "",
    linkList || "(no internal link candidates — write the post without any internal links and return used_internal_link_urls: [])",
    "",
    "Return the JSON object only.",
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
  const prompt = [
    `Editorial illustration for a blog post titled: "${title}".`,
    nicheHint ? `Subject area: ${nicheHint}.` : "",
    "Style: clean, modern, minimal. Muted palette. No text, no UI screenshots, no logos.",
    "Aspect ratio: wide / cinematic, suitable as a blog hero image.",
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
      max_tokens: 4000,
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
