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
import {
  findExchangeCandidates,
  type ExchangeCandidate,
} from "./exchangeMatcher";

const EMBED_MODEL = "text-embedding-3-small";
const CLAUDE_MODEL = "claude-sonnet-4-6";
const IMAGE_MODEL = "gpt-image-1";
const IMAGE_SIZE = "1536x1024";
// gpt-image-1 quality tier: low ($0.011), medium ($0.042), high ($0.167)
// per image at 1536x1024. We pay the premium tier on hero + 3 inline
// (~$0.67/article) for visibly sharper textures and better composition
// — readers spot AI-art at low/medium quality immediately.
const IMAGE_QUALITY: "low" | "medium" | "high" | "auto" = "high";
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
  backlinks_enabled: boolean;
  external_links_per_article: number;
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

export const INLINE_IMAGE_COUNT = 3;
const MAX_PRIOR_ARTICLE_LINKS = 3;

export const ArticleSchema = z.object({
  title: z.string().min(10).max(180),
  slug: z
    .string()
    .min(3)
    .max(96)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase-kebab-case"),
  meta_description: z.string().min(50).max(160),
  excerpt: z.string().min(50).max(240),
  tags: z.array(z.string().min(2).max(40)).min(5).max(8),
  // 7,500-32,000 chars ≈ 1,500-4,800 words. Without an upper bound Claude
  // occasionally produces 70k+ chars, which can't be parsed back as JSON
  // inside max_tokens. The cap is the hard rail; the system prompt asks
  // for 3,200-4,500 words.
  markdown_body: z.string().min(7500).max(32000),
  used_internal_link_urls: z.array(z.string().url()).max(8),
  // Exchange (cross-site) backlinks selected by the Phase 3 matcher.
  // Empty array means the matcher returned no eligible candidates for
  // this topic, OR the site has not opted into the exchange.
  used_exchange_link_urls: z.array(z.string().url()).max(8).default([]),
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
        // Per-image style. Drives the art-direction overlay in
        // generateInlineImage. Default "concept" matches the legacy
        // abstract-editorial behavior so older flows still render.
        kind: z
          .enum(["concept", "chart", "flow", "comparison", "checklist"])
          .default("concept"),
        // For chart/flow/comparison/checklist kinds: 2-6 short text
        // labels (≤24 chars each) that should appear in the image.
        // Empty / ignored for "concept". gpt-image-1 renders these
        // legibly when count is small and labels are short.
        labels: z.array(z.string().max(24)).max(6).default([]),
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

export function buildSystemPrompt(): string {
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
    "- Table of Contents: markdown links to 9–12 H2 sections, each with 2–4 H3 subsection links nested beneath it as an indented sublist. Example shape:",
    "  ```",
    "  ## Table of contents",
    "  - [Section title 1](#section-title-1)",
    "    - [Subsection title 1a](#subsection-title-1a)",
    "    - [Subsection title 1b](#subsection-title-1b)",
    "  - [Section title 2](#section-title-2)",
    "    - [Subsection title 2a](#subsection-title-2a)",
    "  ```",
    "  For each link use `[Section Title](#section-title)` where the fragment is the section title lowercased, non-alphanumerics replaced with hyphens, multiple hyphens collapsed. Every H3 you list in the TOC MUST actually exist as an H3 in the body, and every body H2/H3 should appear in the TOC. Do NOT append `{#id}` attributes to the headings themselves — both our markdown renderers auto-slug headings the same way.",
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
    "Length: STRICTLY 3,200–4,500 words. Hard cap on markdown_body is ~32,000 characters — outputs over that are rejected. Prioritize depth and usefulness; expand with concrete examples, code/config snippets, and edge cases rather than padding.",
    "",
    "TOC + anchors: emit the table of contents as plain markdown anchor links — `- [Section title](#section-id)` — NEVER as raw `<a>` HTML and NEVER with `target=\"_blank\"`. TOC links jump within the same page; opening them in a new tab is a bug.",
    "",
    "Internal links: insert each provided URL inline exactly once as a standard markdown `[anchor](url)` link where the surrounding sentence is genuinely about that URL's topic. Never create a \"Further reading\" list. Never invent URLs — use only those provided. Link candidates may include both site pages AND prior blog posts on this same site — treat both the same way (inline contextual anchor; the prior posts are clearly labeled in the candidate list).",
    "",
    `Inline images: place exactly ${INLINE_IMAGE_COUNT} placeholder lines of the form '<!--INLINE_IMAGE_1-->', '<!--INLINE_IMAGE_2-->', '<!--INLINE_IMAGE_3-->' (each on its own line, in numeric order) inside markdown_body. Place each marker on a blank line immediately after a major H2 boundary, distributed across the body — never inside the intro, the TOC, a blockquote, a table, or inside the final '### Try {brand}' CTA block.`,
    "",
    `For each placeholder, return one object in inline_image_prompts (same 1→${INLINE_IMAGE_COUNT} order). Each object MUST set a kind that fits what the surrounding section is doing — this is the difference between a decorative blob and an informative graphic:`,
    "",
    "- kind=\"chart\" — when the section discusses metrics, percentages, comparisons of magnitudes, or trends. Provide 2–5 short labels (≤24 chars each) that should appear on bars/segments. Plausible numbers are fine; the chart is illustrative.",
    "- kind=\"flow\" — when the section walks through a process or workflow with 3–5 steps. Provide the step labels in order.",
    "- kind=\"comparison\" — when the section explicitly contrasts two approaches (good/bad, before/after, wrong/right). Provide exactly 2 labels (e.g., [\"Before\", \"After\"]).",
    "- kind=\"checklist\" — when the section is a 'do these things' list of 3–6 items. Provide the checklist labels.",
    "- kind=\"concept\" — fallback for atmospheric / opening sections where no data, flow, comparison, or list is being presented. No labels needed.",
    "",
    "Aim for a MIX across the three inline images — at least one should be chart/flow/comparison/checklist when the article has any quantitative or procedural content. 'concept' is fine for at most one of the three.",
    "",
    "alt: a short accessibility description of what the image shows.",
    "prompt: a one-sentence brief describing the image's content (this becomes the image-model prompt). Don't include style direction — the renderer adds it.",
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
  exchangeCandidates: ExchangeCandidate[];
  exchangeSlots: number;
  exchangeRelaxed?: boolean;
}): string {
  const {
    site,
    keyword,
    candidates,
    linkSlots,
    exchangeCandidates,
    exchangeSlots,
    exchangeRelaxed,
  } = input;
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

  const exchangeList = exchangeCandidates
    .map(
      (c, i) =>
        `${i + 1}. [PARTNER BLOG: ${c.domain}] ${c.url}\n   Title: ${c.title}\n   About: ${c.meta_description ?? "(no description)"}`,
    )
    .join("\n");
  const exchangeMax = Math.min(exchangeSlots, exchangeCandidates.length);
  const exchangeSlotLine = exchangeSlots > 0 && exchangeCandidates.length > 0
    ? exchangeRelaxed
      ? `Insert UP TO ${exchangeMax} of the following external partner-blog links. These are pre-vetted blogs in our shared content network — the network is still small, so topical overlap may be loose. Place each as a natural "Related reading from our network: [anchor](url)"-style inline reference where the surrounding paragraph allows even a tangential connection (e.g., a "for adjacent reading" aside, a comparison, or a "teams in {their niche} face similar tradeoffs" sentence). Prefer using all ${exchangeMax}; only skip a candidate if including it would make a paragraph read as obviously incoherent. Do not invent URLs. Return the URLs you used in used_exchange_link_urls.`
      : `Insert UP TO ${exchangeMax} of the following external partner-blog links inline as standard markdown links, where each fits naturally in a sentence whose topic genuinely overlaps. Pick the most relevant — skip any that don't fit; do not force a link. Do not invent URLs. Return the URLs you used in used_exchange_link_urls.`
    : "External-link slots: 0. Return used_exchange_link_urls: [] and do not link out.";

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
    "External partner-blog backlinks (link out to other blogs in the network where topically relevant — these are NOT internal):",
    exchangeSlotLine,
    "",
    exchangeList || "(none available — return used_exchange_link_urls: [])",
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

export async function uniqueSlug(
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
// Shared art-direction across hero + concept-mode inline images.
//
// Previously this said "macro photo of an anodized-aluminum sculpture"
// which is exactly why output looked like cold geometric shapes — the
// model was doing what it was told. New direction is engagement-first:
// scroll-stopping editorial photography that could ship as a magazine
// cover or a Twitter share card, with concrete subject matter (people
// at work, dramatic scenes, expressive moments) instead of abstract
// metallic objects. Mix subjects across articles so the blog index
// doesn't feel like one repeated style.
const SHARED_ART_DIRECTION = [
  // Reference: visual benchmarks people stop scrolling for.
  "Style benchmark: a Time Magazine / National Geographic / Bloomberg Businessweek / The Verge feature-cover photograph. Editorial photojournalism, not abstract digital art. Should feel like a published photograph, not a render.",
  // Subject diversity — break the "geometric metal sculpture" default.
  "Subject: pick the most cinematic option that fits the topic — a person at work with the topic visible in their environment (engineer at a screen, operator in a control room, hands on a keyboard with code reflected in glasses, a researcher at a whiteboard); OR a dramatic scene that evokes the topic (a server room glowing in low light, a city at dusk seen through a window, a single object spotlit on a desk surrounded by cluttered notes); OR a close-up of a real-world workspace artifact (open laptop, well-worn notebook, coffee-ringed printout, glowing terminal). Vary across articles. Faces and hands are welcome — they drive engagement.",
  // Lighting: cinematic but believable.
  "Lighting: cinematic chiaroscuro — one strong directional light source (window, monitor glow, desk lamp) with deep falloff into shadow, plus a subtle warm or cool fill. Mood is contemplative-intense, not corporate-bright. Volumetric light particles welcome.",
  // Palette: richer and varied per piece.
  "Palette: pick ONE coherent palette per image and commit to it — options include teal+amber (Hollywood thriller), emerald+ink (technical noir), cyan+vermilion (cyberpunk editorial), warm sepia+ember (archive-document feel), or cold blue+single accent (datacenter twilight). Avoid pastel washes and avoid pure black backgrounds; mid-tones with bright highlights are the goal.",
  // Texture: real-world grit.
  "Texture: real-world imperfection — fingerprints on screens, dust in light shafts, paper grain, fabric fibers, skin pores, lens flare, mild film grain. The viewer should feel they could touch the surfaces.",
  // Composition: cinematic.
  "Composition: cinematic 3:2, rule-of-thirds with a clear single subject of focus and one or two supporting depth layers. Off-center compositions. Strong foreground/background separation via depth of field. Negative space used intentionally, not as a default.",
  // Optics: editorial portraiture not macro abstract.
  "Optics: 35mm or 50mm prime, f/1.8–f/2.8, shallow depth of field, gentle bokeh, slight lens vignetting. Not over-sharpened — film-like microcontrast.",
  // Hard NOs (kept tight).
  "Strictly NO: typography or UI mockups in the foreground, no logos, no chart-with-labels overlays, no generic abstract gradient blobs, no AI-art clichés (perfectly symmetric robots, melting clocks, glowing brains), no stock-photo handshake shots, no cliché 'man in suit pointing at hologram' compositions. Text-free pixels — the surrounding article copy provides the headline.",
];

// Pull the section that contains the Nth inline-image marker out of
// the article body. Walk backward from the marker to the nearest H2,
// then forward to the next H2 (or EOF), then strip markdown noise so
// gpt-image-1 can read the actual prose / numbers / list items. Caps
// at 1500 chars so we leave headroom for the art-direction blob in
// the final prompt (gpt-image-1 limits the whole prompt to ~4000).
//
// Exported so tests can pin the extraction behavior — wrong section
// content means the chart renders with the wrong numbers, which is
// the failure mode this whole helper exists to prevent.
const MAX_SECTION_EXCERPT_LEN = 1500;
export function extractSectionForMarker(
  markdownBody: string,
  markerIndex: number, // 1-based, matches the <!--INLINE_IMAGE_N--> placeholder
): string {
  const marker = new RegExp(`<!--\\s*INLINE_IMAGE_${markerIndex}\\s*-->`);
  const m = marker.exec(markdownBody);
  if (!m) return "";
  const pos = m.index;

  // Walk backward to find the H2 that opens the containing section.
  const beforeMarker = markdownBody.slice(0, pos);
  const h2Backward = /^##\s+([^\n]+)$/gm;
  let lastH2Start = -1;
  let lastH2Text = "";
  let match: RegExpExecArray | null;
  while ((match = h2Backward.exec(beforeMarker)) !== null) {
    lastH2Start = match.index;
    lastH2Text = match[1].trim();
  }
  if (lastH2Start === -1) return "";

  // Walk forward from the H2 to the next H2 (or end of body).
  const fromH2 = markdownBody.slice(lastH2Start);
  const nextH2 = /\n##\s+/g;
  nextH2.lastIndex = 3; // skip the opening H2 itself
  const nextMatch = nextH2.exec(fromH2);
  const sectionRaw = nextMatch ? fromH2.slice(0, nextMatch.index) : fromH2;

  const cleanedHeading = lastH2Text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
  return cleanSectionMarkdown(sectionRaw, cleanedHeading).slice(
    0,
    MAX_SECTION_EXCERPT_LEN,
  );
}

function cleanSectionMarkdown(section: string, heading: string): string {
  // Strip noise that doesn't help the image model: image markdown,
  // anchor-attribute braces, inline-image placeholder comments, code
  // fences (keep their content as plain text), and excess blank lines.
  let s = section
    .replace(/<!--\s*INLINE_IMAGE_\d+\s*-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")        // ![alt](url)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")     // [text](url) -> text
    .replace(/```[a-z]*\n([\s\S]*?)```/g, "$1")  // strip fence markers, keep code text
    .replace(/^\s*\{#[a-z0-9-]+\}\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Prepend the section heading so the image model knows what topic
  // this section is about even if the excerpt gets truncated.
  return `Section heading: "${heading}"\n\n${s}`;
}

// Visual-design language shared across all infographic-style inline
// images. Keeps charts/flows/comparisons/checklists feeling like they
// came from the same magazine even though Claude wrote each prompt
// independently. Different from SHARED_ART_DIRECTION (which is for
// "concept" mode + the hero) — that one explicitly forbids text;
// this one explicitly permits it.
const INFOGRAPHIC_ART_DIRECTION = [
  "Style: clean editorial infographic — the kind you'd see in a Bloomberg, Stripe Press, or Information is Beautiful piece. NOT a 3D render, NOT a slide template, NOT clip-art.",
  "Surface: matte off-white paper background (#F2EFE8-ish) with one charcoal accent (#1A1F26) and ONE saturated highlight color picked from {electric cyan, deep emerald, warm amber, vermilion} — pick one and stick to it for the whole figure.",
  "Typography: legible sans-serif (Inter / SF Pro feel), tight tracking, NO ALL-CAPS body text, generous whitespace. Labels short and unambiguous. Numbers rendered cleanly.",
  "Lines: 1.5–2px strokes, no drop shadows, no gradient fills unless explicitly part of a data series. Rounded corners on shape primitives.",
  "Layout: 3:2 aspect, asymmetric balance, single clear visual hierarchy. Title-free — the surrounding article copy provides the headline.",
  "Strictly NO photographic textures, NO 3D bevels, NO gradients on backgrounds, NO emoji, NO stock-icon people, NO faux-handwriting fonts, NO drop-shadows on text.",
];

function buildInlineImagePrompt(
  spec: {
    prompt: string;
    kind: string;
    labels: string[];
    sectionContext?: string;
  },
  nicheHint: string | null,
): string {
  const labels = (spec.labels ?? []).map((l) => l.trim()).filter(Boolean);
  const labelClause = labels.length > 0
    ? `Render these exact short text labels — spell them precisely, do not paraphrase: ${labels.map((l) => `"${l}"`).join(", ")}.`
    : "";
  const niche = nicheHint ? `Subject area: ${nicheHint}.` : "";
  // Source-of-truth section text — the image model reads it for actual
  // numbers / labels / list items instead of inventing plausible ones.
  // For "concept" we don't pass section context: that mode is a tactile
  // metaphor, not a literal depiction.
  const sectionClause = spec.sectionContext && spec.kind !== "concept"
    ? `Source content from the article section this figure illustrates — pull labels, numbers, list items, and ordering from this prose, do NOT invent your own:\n${spec.sectionContext}`
    : "";

  switch (spec.kind) {
    case "chart": {
      return [
        "Editorial bar-chart infographic for a long-form technical article.",
        `Topic: ${spec.prompt}.`,
        niche,
        sectionClause,
        "Render a simple 3–5 segment vertical bar chart (or horizontal if it fits the labels better). Each bar has a clear short label beneath/beside it and one rendered numeric value on or above the bar (percentages OK). Use values from the section content above when present; otherwise plausible illustrative numbers.",
        labelClause,
        "One bar should be visually emphasized in the accent color; the rest in charcoal.",
        ...INFOGRAPHIC_ART_DIRECTION,
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "flow": {
      return [
        "Editorial process-flow diagram for a long-form technical article.",
        `Topic: ${spec.prompt}.`,
        niche,
        sectionClause,
        "Render a left-to-right (or top-to-bottom if labels are long) sequence of 3–5 rounded-rectangle nodes connected by single arrows. Each node contains one short label drawn from the section content above (or the labels list). The final node is the outcome and is emphasized in the accent color.",
        labelClause,
        ...INFOGRAPHIC_ART_DIRECTION,
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "comparison": {
      return [
        "Editorial side-by-side comparison panel for a long-form technical article.",
        `Topic: ${spec.prompt}.`,
        niche,
        sectionClause,
        "Render exactly two vertical columns separated by a thin vertical divider. Each column has its label as the column header and 3–4 short bullet-style items below — pulled from the comparison points in the section content above when possible. One icon glyph (geometric primitive, NOT emoji) next to each item. The 'good' / 'after' / 'right' column gets the accent color; the other is charcoal.",
        labelClause,
        ...INFOGRAPHIC_ART_DIRECTION,
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "checklist": {
      return [
        "Editorial visual checklist for a long-form technical article.",
        `Topic: ${spec.prompt}.`,
        niche,
        sectionClause,
        "Render a stacked vertical list of 3–6 items drawn from the actionable items in the section content above (or the labels list), each prefixed with a small filled square in the accent color. Items aligned left, generous line height. No screenshot framing.",
        labelClause,
        ...INFOGRAPHIC_ART_DIRECTION,
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "concept":
    default: {
      // Legacy tactile-metaphor path. Used when the section is
      // atmospheric and there's nothing structural to visualize.
      return [
        `Editorial section image for a long-form technical SEO article.`,
        `Concept to evoke (do NOT depict literally — find a tactile metaphor): ${spec.prompt}.`,
        niche,
        ...SHARED_ART_DIRECTION,
        "Slightly more subdued than a hero — a chapter divider, not the cover. 3:2 aspect.",
      ]
        .filter(Boolean)
        .join(" ");
    }
  }
}

export async function generateInlineImage(
  openai: OpenAI,
  promptText: string,
  nicheHint: string | null,
  opts: { kind?: string; labels?: string[]; sectionContext?: string } = {},
): Promise<Buffer | null> {
  const prompt = buildInlineImagePrompt(
    {
      prompt: promptText,
      kind: opts.kind ?? "concept",
      labels: opts.labels ?? [],
      sectionContext: opts.sectionContext,
    },
    nicheHint,
  );
  const res = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt,
    size: IMAGE_SIZE,
    quality: IMAGE_QUALITY,
    n: 1,
  });
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) return null;
  return Buffer.from(b64, "base64");
}

export type HeroImageMeta = {
  title: string;
  excerpt?: string | null;
  metaDescription?: string | null;
  tags?: string[] | null;
  niche?: string | null;
  audiences?: string[] | null;
  brand?: string | null;
};

export async function generateImage(
  openai: OpenAI,
  meta: HeroImageMeta,
): Promise<Buffer | null> {
  // Hero image. The thumbnail on /blog AND the OG card on every share —
  // it has to stop a scroll on a phone. Aim for an editorial cover that
  // a magazine art director would approve: a clear human or scene
  // subject, dramatic light, one striking color combination.
  //
  // We feed the model the actual article metadata (title, lede,
  // tags, audience) so it has more to anchor on than the bare headline.
  // Without the lede, gpt-image-1 collapses every abstract title into
  // the same generic geometric render.
  const lede = (meta.excerpt || meta.metaDescription || "").trim();
  const tagList = (meta.tags ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);
  const audienceList = (meta.audiences ?? [])
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, 3);
  const prompt = [
    `Hero cover photograph for a long-form technical feature titled: "${meta.title}".`,
    lede ? `What the piece is actually about: ${lede}` : "",
    tagList.length > 0 ? `Topic tags: ${tagList.join(", ")}.` : "",
    meta.niche ? `Subject area: ${meta.niche}.` : "",
    audienceList.length > 0
      ? `Audience the piece is for: ${audienceList.join("; ")}. If you place a person in the frame, they should plausibly belong to that audience (clothing, environment, tools).`
      : "",
    meta.brand
      ? `Publication: ${meta.brand} — operator-focused technical journalism, not corporate marketing.`
      : "",
    "Pick the single most cinematic, scroll-stopping visual that fits the topic — preferably a real-feeling moment (a person at work, a charged scene, a single dramatic object lit in context) rather than abstract geometric shapes. Make it look like a published feature-story photograph, NOT an AI-generated abstract pattern.",
    ...SHARED_ART_DIRECTION,
    "Cinematic 3:2 magazine cover aspect. Single-image composition with a clear focal subject; never a collage. Must read well as a 320×213px social-card thumbnail.",
  ]
    .filter(Boolean)
    .join(" ");
  const res = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt,
    size: IMAGE_SIZE,
    quality: IMAGE_QUALITY,
    n: 1,
  });
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) return null;
  return Buffer.from(b64, "base64");
}

export async function uploadImage(
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
      "id, user_id, domain, blog_root_url, niche, target_audiences, description, internal_links_per_article, backlinks_enabled, external_links_per_article, status",
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

  // Build the link-exchange candidate pool from three sources, ordered
  // by SEO value: prior posts (own + sitemap-discovered) carry topical
  // authority and inbound link equity to specific articles; pillar pages
  // anchor entity-level signals. Deduped by URL; capped at
  // MAX_LINK_CANDIDATES so the prompt doesn't bloat.
  //
  // Source 1+2: lx_site_page via pgvector RPC, one call per is_blog_post
  // value so both pillar pages AND existing on-site blog posts surface.
  const sitePageSlots = Math.min(
    typedSite.internal_links_per_article,
    MAX_LINK_CANDIDATES,
  );
  let candidates: LabeledCandidate[] = [];
  if (sitePageSlots > 0) {
    const [{ data: pillarRows, error: pillarErr }, { data: blogRows, error: blogErr }] =
      await Promise.all([
        supabase.rpc("lx_find_internal_links", {
          p_site_id: typedSite.id,
          p_query_embedding: queryEmbedding,
          p_limit: sitePageSlots * 2,
          p_is_blog_post: false,
        }),
        supabase.rpc("lx_find_internal_links", {
          p_site_id: typedSite.id,
          p_query_embedding: queryEmbedding,
          p_limit: sitePageSlots * 2,
          p_is_blog_post: true,
        }),
      ]);
    if (pillarErr) console.warn("[lx] pillar-link rpc failed", pillarErr.message);
    if (blogErr) console.warn("[lx] blog-link rpc failed", blogErr.message);
    const pillars = ((pillarRows as LinkCandidate[] | null) ?? []).map((c) => ({
      ...c,
      kind: "site_page" as const,
    }));
    const sitemapBlogs = ((blogRows as LinkCandidate[] | null) ?? []).map((c) => ({
      ...c,
      kind: "prior_post" as const,
    }));
    candidates = [...pillars, ...sitemapBlogs];
  }

  // Source 3: lx_article — articles we generated ourselves. Token-overlap
  // scoring; complements pgvector when the same post hasn't been re-crawled
  // into lx_site_page yet.
  const priorArticles = await findPriorArticles(
    supabase,
    typedSite.id,
    typedSite.blog_root_url,
    keyword.keyword,
    typedSite.niche,
  );
  candidates = [
    ...candidates,
    ...priorArticles.map((c) => ({ ...c, kind: "prior_post" as const })),
  ];

  // Dedupe by normalized URL — the same post can appear in both lx_site_page
  // (via sitemap crawl) and lx_article (via our generation). Preserve order
  // (first occurrence wins) so the SEO-ranked sources stay ranked.
  const seen = new Set<string>();
  candidates = candidates
    .filter((c) => {
      const key = c.url.replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_LINK_CANDIDATES);
  const linkSlots = Math.min(candidates.length, MAX_LINK_CANDIDATES);

  // Source 4: Phase 3 link-exchange candidates — articles on OTHER
  // opted-in sites in the network whose topic overlaps. Only requested
  // when this site has explicitly opted in via backlinks_enabled and
  // configured external_links_per_article > 0.
  const exchangeSlots = typedSite.backlinks_enabled
    ? Math.max(0, typedSite.external_links_per_article)
    : 0;
  const exchangeMatch = await findExchangeCandidates(supabase, {
    selfSiteId: typedSite.id,
    selfNiche: typedSite.niche,
    keyword: keyword.keyword,
    slots: exchangeSlots,
  });
  const exchangeCandidates = exchangeMatch.candidates;
  const exchangeRelaxed = exchangeMatch.relaxed;
  if (exchangeSlots > 0) {
    console.log(
      `[lx] exchange candidates for ${typedSite.id} keyword="${keyword.keyword}": ${exchangeCandidates.length}/${exchangeSlots} slots (mode=${exchangeRelaxed ? "relaxed" : "strict"}, network=${exchangeMatch.networkSize})`,
    );
  }

  // Generate the article body.
  let article: ArticleOutput;
  try {
    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL,
      // 3,200–4,500 words ≈ ~18k–25k output tokens. JSON escape overhead
      // for markdown (every \n + every " in code blocks gets escaped)
      // can push that another 30%. 48k gives meaningful headroom so the
      // model isn't truncated mid-string — which manifests as
      // "Unterminated string in JSON" on parse.
      max_tokens: 48000,
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
            exchangeCandidates,
            exchangeSlots,
            exchangeRelaxed,
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
    const errMsg = err instanceof Error ? err.message : String(err);
    // Anthropic monthly-cap (HTTP 400 "specified API usage limits") and
    // generic rate-limit (HTTP 429) are transient. Marking the keyword
    // 'failed' here permanently consumes it — when the cap resets the
    // user is stuck with stranded rows and a dedup'd research path that
    // never re-inserts them. Requeue instead so the keyword retries on
    // the next worker tick once the upstream is back.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (err as any)?.status;
    const isTransient =
      status === 429 ||
      /specified API usage limits|usage limits|rate.?limit/i.test(errMsg);
    if (isTransient) {
      await supabase
        .from("lx_keyword")
        .update({ status: "queued" })
        .eq("id", keyword.id);
      await refundCredit(supabase, typedSite.user_id);
      console.warn(
        `[lx] keyword ${keyword.id} requeued (transient claude error): ${errMsg}`,
      );
      return { ok: false, error: "claude transient error" };
    }
    await failKeyword(supabase, keyword.id, `claude error: ${errMsg}`);
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

  // Validate exchange links similarly. The prompt frames these as UP TO
  // (not EXACTLY) — a 0 here just means the model judged none fit, not a
  // failure. Only flag when the model claims a URL it didn't actually
  // place, or claims a URL we never offered as a candidate.
  const exchangeUrlsUsed = article.used_exchange_link_urls ?? [];
  const offeredExchangeUrls = new Set(exchangeCandidates.map((c) => c.url));
  const phantomExchange = exchangeUrlsUsed.filter(
    (u) => !offeredExchangeUrls.has(u),
  );
  if (phantomExchange.length > 0) {
    await failKeyword(
      supabase,
      keyword.id,
      `claude used exchange URLs not in candidate list: ${phantomExchange.join(", ")}`,
    );
    await refundCredit(supabase, typedSite.user_id);
    return { ok: false, error: "exchange-link validation failed" };
  }
  const exchangeCheck = validateInternalLinks(
    article.markdown_body,
    exchangeUrlsUsed,
  );
  if (!exchangeCheck.ok) {
    await failKeyword(
      supabase,
      keyword.id,
      `claude claimed exchange links not present: ${exchangeCheck.missing.join(", ")}`,
    );
    await refundCredit(supabase, typedSite.user_id);
    return { ok: false, error: "exchange-link validation failed" };
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
        const bytes = await generateImage(openai, {
          title: article.title,
          excerpt: article.excerpt,
          metaDescription: article.meta_description,
          tags: article.tags,
          niche: typedSite.niche,
          audiences: typedSite.target_audiences,
          brand: typedSite.domain ?? null,
        });
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
        const sectionContext = extractSectionForMarker(article.markdown_body, i + 1);
        const bytes = await generateInlineImage(openai, p.prompt, typedSite.niche, {
          kind: p.kind,
          labels: p.labels,
          sectionContext,
        });
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

  // Strip pandoc-style `## Heading {#anchor-id}` attributes from headings.
  // Both our renderers (pandoc with gfm_auto_identifiers, marked with the
  // custom heading renderer) auto-slug headings, so explicit IDs are noise.
  // Claude sometimes emits them anyway as a TOC anchoring hint; without
  // header_attributes enabled they leak through as visible "{#…}" text on
  // the rendered page.
  bodyWithImages = bodyWithImages.replace(
    /^(#{1,6}[^\n]*?)\s*\{#[a-z0-9][a-z0-9-]*\}\s*$/gim,
    "$1",
  );

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
  const usedExchange = exchangeCandidates.filter((c) =>
    exchangeUrlsUsed.includes(c.url),
  );
  const outboundLinksPayload = usedExchange.map((c) => ({
    url: c.url,
    anchor: c.title,
    site_domain: c.domain,
  }));

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
      outbound_links: outboundLinksPayload,
      status: "ready",
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    await failKeyword(supabase, keyword.id, `insert failed: ${insErr?.message}`);
    await refundCredit(supabase, typedSite.user_id);
    return { ok: false, error: insErr?.message ?? "insert failed" };
  }

  // Append-only lx_backlink ledger — one row per actually-placed exchange
  // link. Best-effort: a failure here doesn't unwind the article (the
  // article is the user's product; the ledger is internal bookkeeping).
  if (usedExchange.length > 0) {
    const ledgerRows = usedExchange.map((c) => ({
      giver_site_id: typedSite.id,
      giver_article_id: inserted.id,
      receiver_site_id: c.site_id,
      receiver_article_id: c.article_id,
      target_url: c.url,
      anchor: c.title,
    }));
    const { error: ledgerErr } = await supabase
      .from("lx_backlink")
      .insert(ledgerRows);
    if (ledgerErr) {
      console.warn(
        `[lx] backlink ledger insert failed for article ${inserted.id}:`,
        ledgerErr.message,
      );
    }
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
export async function refundCredit(
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
