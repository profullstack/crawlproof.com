import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";
// The SDK zod helper needs v4 schemas (z.toJSONSchema). Mirrors brandProfileFetch.
import { z } from "zod/v4";
import { env } from "@/lib/env";
import { generateStructuredOutput } from "@/lib/lx/backendAi";
import { extractSiteBrand, type SiteBrand } from "./brand";
import { resolveAdHeroImage } from "./heroImage";
import { renderCreativeText, renderTerminalHtml } from "./terminal";
import { renderFeedHtml } from "./feeditem";
// One implementation, next to the renderers that consume it. Re-exported so a
// server-side caller working with summaries has a single import.
export { summaryParagraphs } from "./feeditem";
import {
  AD_FORMATS,
  AD_FORMAT_IDS,
  brandInitial,
  formatSpec,
  hexToRgba,
  type AdCreative,
  type AdFormatId,
} from "./formats";

// Re-export the client-safe format primitives so existing server importers of
// this module keep working; client components should import from ./formats.
export { AD_FORMATS, AD_FORMAT_IDS, formatSpec };
export { renderCreativeText, renderTerminalHtml };
export type { AdCreative, AdFormatId };

// Copy is generated once per URL by a frontier-ish model; sizes are rendered
// from the same copy set. Cheap, fast, and editable — no image-gen required.
// Must be a model that supports structured outputs (output_config.format) —
// Sonnet 4.6 does NOT, so its fallback silently fails "parse structured output".
const CLAUDE_MODEL = "claude-sonnet-5";
const OPENAI_MODEL = "gpt-5-mini";

const HEX = /^#([0-9a-fA-F]{6})$/;
function safeHex(v: string | undefined, fallback: string): string {
  return v && HEX.test(v.trim()) ? v.trim().toLowerCase() : fallback;
}

const CopySchema = z.object({
  headline: z
    .string()
    .max(48)
    .describe("Punchy ad headline in the brand's voice — max ~6 words, no period."),
  shortHeadline: z
    .string()
    .max(28)
    .describe("A tighter version for tiny mobile banners — max ~4 words."),
  // Structured-output SDKs strip maxLength and validate client-side, so a tight
  // cap makes the whole generation throw when copy runs a few chars long. Keep
  // the prompt guidance short but the hard cap generous (creatives re-truncate).
  body: z
    .string()
    .max(130)
    .describe("One concrete benefit line, ~12 words max. No hype, no exclamation spam."),
  ctaText: z
    .string()
    .max(18)
    .describe("Button label, e.g. 'Try it free', 'Get started', 'Learn more'."),
  bgColor: z.string().describe("Background hex like #0b0d10 — on-brand, good contrast with fg."),
  fgColor: z.string().describe("Text hex with strong contrast against bg."),
  accentColor: z.string().describe("Accent/CTA hex — the brand's signature colour if visible."),
  // The two prose lengths. Everything above is display copy sized for a box;
  // these are for placements that sit *inside* somebody's writing, where the ad
  // is read rather than glanced at.
  summaryShort: z
    .string()
    .max(400)
    .describe(
      "One or two plain sentences saying what this is and who it is for, in third person. " +
        "Reads as an editorial note, not a slogan — no exclamation marks, no second person, no CTA.",
    ),
  summaryLong: z
    .string()
    .max(1600)
    .describe(
      "Two or three short paragraphs, separated by a blank line, for a sponsored section of a " +
        "blog post. Third person, factual, specific to this product. Describe what it does, who " +
        "it is for, and what is distinctive — only from the page content. No headings, no lists, " +
        "no markdown, no links, no invented metrics or prices.",
    ),
});
type AdCopy = z.infer<typeof CopySchema>;

/**
 * The summary half of CopySchema on its own, derived from it rather than
 * retyped so the two can never disagree about lengths or descriptions.
 */
export const SummarySchema = CopySchema.pick({ summaryShort: true, summaryLong: true });

/**
 * How the editorial summaries must be written.
 *
 * Split out because two callers need exactly these words: the full creative
 * generation above, and `generateAdSummary` below, which the backfill script
 * uses to fill in campaigns that predate the feature. If the two prompts
 * drifted, a backfilled campaign would read differently from a freshly
 * generated one and nobody would know why.
 *
 * The register instruction is doing real work. Without it the model returns
 * three restatements of the headline, which is useless: these run inside other
 * people's writing, next to their prose, and ad voice is exactly what makes
 * them read as an intrusion and get skipped.
 */
export const SUMMARY_RULES: readonly string[] = [
  "Write two editorial summaries of the advertiser, in a different register from",
  "display ad copy: third person, calm, factual, the way a journalist would",
  "describe the product in one line of a round-up. No slogans, no second person, no",
  "calls to action, no exclamation marks, no hype adjectives ('revolutionary',",
  "'game-changing', 'seamless'). summaryShort is one or two sentences. summaryLong",
  "is two or three short paragraphs separated by blank lines.",
  "Never invent anything, and note this binds harder here than for a headline:",
  "these are longer, so there is more room to fabricate. Every fact must come from",
  "the page content. If the page does not say who it is for, or what it costs, or",
  "how it works, then neither do you — write less rather than filling the space.",
];

const SYSTEM_PROMPT = [
  "You are a senior performance-marketing copywriter and brand designer.",
  "Given a company's website content and detected brand colours, write a single",
  "display-ad concept: a headline, a tiny mobile headline, one benefit line, a CTA,",
  "and an on-brand colour trio (background, foreground, accent).",
  "Rules: infer voice and value proposition ONLY from the provided content — never",
  "invent features, prices, or claims. Keep it concrete and specific to this product.",
  "Colours must be readable: high contrast between background and foreground.",
  "Prefer the site's real brand/accent colour when the palette makes it obvious.",
  ...SUMMARY_RULES,
].join(" ");

function buildUserPrompt(brand: SiteBrand): string {
  return [
    `Company site: ${brand.url}`,
    `Title: ${brand.title || "(none)"}`,
    brand.description ? `Description: ${brand.description}` : "",
    brand.themeColor ? `Declared theme-color: ${brand.themeColor}` : "",
    brand.palette.length ? `Detected palette (most common first): ${brand.palette.join(", ")}` : "",
    "",
    "Page content:",
    brand.text || "(no readable text found — infer from the domain and title)",
  ]
    .filter(Boolean)
    .join("\n");
}

function copyToCreatives(brand: SiteBrand, copy: AdCopy, heroUrl: string | null): AdCreative[] {
  const bg = safeHex(copy.bgColor, brand.themeColor && HEX.test(brand.themeColor) ? brand.themeColor : "#0b0d10");
  const fg = safeHex(copy.fgColor, "#e7e9ee");
  const accent = safeHex(copy.accentColor, brand.palette[0] ?? "#6ee7b7");
  const base = {
    bgColor: bg,
    fgColor: fg,
    accentColor: accent,
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    logoUrl: brand.logoUrl,
    imageUrl: heroUrl,
    body: copy.body,
    ctaText: copy.ctaText || "Learn more",
  };
  return AD_FORMAT_IDS.map((format) => ({
    format,
    // tiny banner uses the short headline; others use the full one
    headline: format === "banner_320x50" ? copy.shortHeadline || copy.headline : copy.headline,
    ...base,
  }));
}

/**
 * Editorial prose about the advertiser, in two lengths, plus the domain it was
 * written from.
 *
 * `domain` is what makes the pair trustworthy later: a campaign's destination
 * can be edited after generation, and prose describing a site the campaign no
 * longer points at is worse than no prose at all. Serving compares this against
 * the campaign's current domain and treats a mismatch as absent.
 */
export type AdSummary = {
  short: string;
  long: string;
  domain: string;
};

/** The host a summary describes, normalised the way ad_campaigns stores it. */
export function summaryDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Tidy a generated summary.
 *
 * Collapses the runs of blank lines a model likes to emit into single paragraph
 * breaks, strips any markdown it reached for despite being told not to, and
 * caps the length. Returns "" when there is nothing usable, which every caller
 * treats as "no summary" rather than rendering an empty paragraph.
 */
export function cleanSummary(v: unknown, maxLen: number): string {
  const text = String(v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    // Markdown emphasis/heading/list marks: the summaries are rendered as HTML
    // and as plain text, and neither wants a stray asterisk.
    // [ \t] rather than \s: with the m flag, \s also matches the newline
    // *before* the anchor, so stripping a heading or a bullet swallowed the
    // blank line that separated it from the previous paragraph and silently
    // merged the two.
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$)/g, "$1$2")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
  return text.slice(0, maxLen);
}

/**
 * Just the two summaries, for a campaign that already has creatives.
 *
 * Deliberately not `generateAdCreatives`. That regenerates the whole concept —
 * colours, four creatives, and a hero image through gpt-image when a Supabase
 * client is passed — which for a backfill would be both far more expensive and
 * actively destructive: it would replace copy an advertiser may have edited by
 * hand. This reads the page, writes the prose, and touches nothing else.
 *
 * The prompt is the same SUMMARY_RULES the full generator uses, so a backfilled
 * campaign reads like a freshly generated one.
 */
export async function generateAdSummary(
  rawUrl: string,
  opts: { anthropic?: Anthropic | null; openai?: OpenAI | null } = {},
): Promise<{ summary: AdSummary; provider: string; title: string }> {
  const brand = await extractSiteBrand(rawUrl);

  // Nothing readable came back, so there is nothing to summarise. Asked anyway,
  // a model that has been told not to invent does the honest thing and
  // describes *the fetch* — "a Tor .onion address; the page contains no
  // readable text" — which is accurate, useless, and would be published inside
  // somebody's blog post as though it were ad copy. An empty summary is the
  // correct answer and every caller already treats it as "no prose".
  if (readableTextLength(brand.text) < MIN_SUMMARY_SOURCE_CHARS) {
    return {
      summary: { short: "", long: "", domain: summaryDomain(brand.url || rawUrl) },
      provider: "skipped:no-content",
      title: brand.title ?? "",
    };
  }

  const anthropic =
    opts.anthropic ?? (env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null);
  const openai =
    opts.openai ?? (env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null);

  const { provider, output } = await generateStructuredOutput<{
    summaryShort: string;
    summaryLong: string;
  }>({
    name: "ad_summary",
    schema: SummarySchema,
    system: ["You are a technology journalist writing a neutral product note.", ...SUMMARY_RULES].join(
      " ",
    ),
    user: buildUserPrompt(brand),
    maxTokens: 3000,
    anthropicModel: CLAUDE_MODEL,
    openaiModel: OPENAI_MODEL,
    anthropic,
    openai,
    anthropicEffort: "low",
  });

  const short = cleanSummary(output.summaryShort, 400);
  const long = cleanSummary(output.summaryLong, 1600);

  // Second line of defence. The input guard catches an empty page; this catches
  // the page that had *some* text but not enough to describe, where the model
  // writes about the document instead of the product. Either way the prose is
  // discarded rather than published.
  const usable = !describesTheFetch(short) && !describesTheFetch(long);

  return {
    summary: {
      short: usable ? short : "",
      long: usable ? long : "",
      domain: summaryDomain(brand.url || rawUrl),
    },
    provider: usable ? provider : `rejected:meta:${provider}`,
    title: brand.title ?? "",
  };
}

/** Minimum readable characters on a page before it is worth summarising. */
const MIN_SUMMARY_SOURCE_CHARS = 200;

/** Words-worth of text, ignoring the whitespace a stripped page is mostly made of. */
function readableTextLength(text: string | null | undefined): number {
  return String(text ?? "").replace(/\s+/g, " ").trim().length;
}

/**
 * Does this summary describe the page we fetched rather than the product?
 *
 * A model told never to invent will, given an empty or unreadable page, write
 * something true about the *document* — that it has no readable text, that it
 * could not be accessed, that it appears to be a placeholder. True, and exactly
 * what must never be rendered as an advertiser's description of themselves.
 *
 * Matching on phrases is crude, but the failure it guards is loud and narrow:
 * real product copy does not talk about fetching, page content, or what could
 * not be determined.
 */
export function __test_describesTheFetch(text: string): boolean {
  return describesTheFetch(text);
}

function describesTheFetch(text: string): boolean {
  if (!text) return false;
  return /\b(no readable (text|content)|the (fetched |retrieved )?page (contains|provides|has)\b|could not (be )?(access|retriev|fetch|determin|load)|unable to (access|determine|retrieve|load)|no information (about|is)|appears to be (empty|a placeholder|blank)|not enough information|no content (was )?(found|available)|placeholder page|under construction)/i.test(
    text,
  );
}

export async function generateAdCreatives(
  rawUrl: string,
  opts: { supabase?: SupabaseClient } = {},
): Promise<{
  brand: SiteBrand;
  creatives: AdCreative[];
  provider: string;
  summary: AdSummary;
}> {
  const brand = await extractSiteBrand(rawUrl);

  const anthropic = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null;
  const openai = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;

  const { provider, output } = await generateStructuredOutput<AdCopy>({
    name: "ad_copy",
    schema: CopySchema,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(brand),
    // Reasoning models (gpt-5-mini) spend output budget on reasoning before the
    // structured copy, so keep generous headroom even though the copy is tiny.
    maxTokens: 3000,
    anthropicModel: CLAUDE_MODEL,
    openaiModel: OPENAI_MODEL,
    anthropic,
    openai,
    anthropicEffort: "low",
  });

  // Hero image: the advertiser's og:image when it exists, else a gpt-image-1
  // fallback (only when we have a Supabase client to host the upload). Best-
  // effort — a failure just leaves the accent-tint background.
  let heroUrl: string | null = null;
  if (opts.supabase) {
    const hero = await resolveAdHeroImage({
      brand,
      copy: { headline: output.headline, body: output.body, bgColor: output.bgColor, accentColor: output.accentColor },
      openai,
      supabase: opts.supabase,
    }).catch(() => null);
    heroUrl = hero?.url ?? null;
  }

  // The summaries are written from the page we just read, so the domain they
  // describe is that page's — not whatever the campaign's destination is edited
  // to later. Recording it here is what lets serving decide the prose is stale.
  const summary: AdSummary = {
    short: cleanSummary(output.summaryShort, 400),
    long: cleanSummary(output.summaryLong, 1600),
    domain: summaryDomain(brand.url || rawUrl),
  };

  return { brand, creatives: copyToCreatives(brand, output, heroUrl), provider, summary };
}

// Append the campaign ref for click attribution, preserving any existing query.
export function appendRef(destinationUrl: string, refSlug: string): string {
  try {
    const u = new URL(destinationUrl);
    u.searchParams.set("ref", refSlug);
    return u.toString();
  } catch {
    const sep = destinationUrl.includes("?") ? "&" : "?";
    return `${destinationUrl}${sep}ref=${encodeURIComponent(refSlug)}`;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The brand mark: a real <img> logo when we have one, otherwise an accent-tinted
// monogram tile. Never renders empty. Sandboxed served ads can't run JS, so we
// only show the <img> when the URL was verified at generation time.
function markHtml(creative: AdCreative, size: number): string {
  if (creative.logoUrl) {
    return `<img src="${esc(creative.logoUrl)}" alt="" style="height:${size}px;width:auto;max-width:${Math.round(size * 3)}px;border-radius:4px;flex:0 0 auto;object-fit:contain" />`;
  }
  const fs = Math.round(size * 0.55);
  return `<span style="height:${size}px;width:${size}px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;border-radius:6px;background:${creative.accentColor};color:${hexToRgba(creative.bgColor, 1)};font-weight:800;font-size:${fs}px;line-height:1">${esc(brandInitial(creative.headline))}</span>`;
}

// Self-contained HTML for a creative — used by the served ad unit inside an
// isolated iframe (and mirrored by the React <AdPreview>). clickUrl is the
// destination with ?ref= already applied.
export function renderCreativeHtml(creative: AdCreative, clickUrl: string): string {
  const { w, h } = formatSpec(creative.format);

  // Terminal ad — the ASCII artwork in a <pre>, so the same creative can also
  // fill a web slot. The canonical delivery is /api/ads/motd (text/plain).
  if (creative.format === "terminal_ascii") {
    return renderTerminalHtml(creative, clickUrl);
  }

  // Feed ad — the sponsored line as it will appear inside somebody's reader.
  // Canonically delivered as a syndication item by /api/ads/feed; this path is
  // what makes the same creative previewable in the browser, so it deliberately
  // adds no styling the feed body would not survive. The wrapper only supplies
  // a readable page background, since a feed body is rendered by the reader's
  // own stylesheet rather than by ours.
  if (creative.format === "feed_item") {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:12px;background:${creative.bgColor};color:${creative.fgColor};
        font-family:${creative.fontFamily};font-size:14px;line-height:1.45}
      a{color:${creative.accentColor}}
      pre{overflow:auto;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
      hr{border:0;border-top:1px solid rgba(255,255,255,.14)}
    </style></head><body>${renderFeedHtml(creative, clickUrl)}</body></html>`;
  }

  // Native text link — a borderless, full-width single line. No image/box.
  if (creative.format === "text_link") {
    const body = creative.body
      ? `<span style="color:${creative.fgColor};opacity:.72;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto">— ${esc(creative.body)}</span>`
      : "";
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0}
      a{text-decoration:none;display:block}
      .cp-ad{display:flex;align-items:center;gap:8px;width:100%;height:${h}px;
        background:${creative.bgColor};font-family:${creative.fontFamily};font-size:13px;
        padding:0 12px;overflow:hidden;border-radius:8px;
        border:1px solid rgba(255,255,255,.08);border-left:3px solid ${creative.accentColor}}
    </style></head><body>
      <a class="cp-ad" href="${esc(clickUrl)}" target="_blank" rel="noopener sponsored">
        <span style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:${creative.accentColor};flex:0 0 auto">Sponsored</span>
        <strong style="color:${creative.fgColor};flex:0 0 auto;white-space:nowrap">${esc(creative.headline)}</strong>
        ${body}
        <span style="color:${creative.accentColor};font-weight:600;flex:0 0 auto;white-space:nowrap">${esc(creative.ctaText)} →</span>
      </a>
    </body></html>`;
  }

  const isLeaderboard = creative.format === "banner_728x90";
  const isMobile = creative.format === "banner_320x50";
  const row = isLeaderboard || isMobile;
  const showBody = !isMobile;
  const mark = markHtml(creative, isMobile ? 20 : 28);
  const cta = `<span style="background:${creative.accentColor};color:${hexToRgba(creative.bgColor, 1)};font-weight:600;border-radius:6px;padding:${isMobile ? "4px 8px" : "7px 12px"};font-size:${isMobile ? 11 : 13}px;white-space:nowrap">${esc(creative.ctaText)}</span>`;

  // On the rectangle a hero image reads best full-bleed with a bottom gradient
  // (matches the house ad); text colour stays readable over it.
  const heroText = row ? creative.fgColor : creative.imageUrl ? "#f4f7fb" : creative.fgColor;
  const text = `
    <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
      <div style="font-weight:700;font-size:${isMobile ? 13 : isLeaderboard ? 16 : 18}px;line-height:1.15;color:${heroText};overflow:hidden;text-overflow:ellipsis;${isMobile ? "white-space:nowrap" : ""}">${esc(creative.headline)}</div>
      ${showBody ? `<div style="font-size:${isLeaderboard ? 12 : 13}px;line-height:1.3;color:${heroText};opacity:.85">${esc(creative.body)}</div>` : ""}
    </div>`;

  const inner = row
    ? `<div style="display:flex;align-items:center;gap:12px;width:100%;height:100%">${mark}${text}<div style="margin-left:auto;flex:0 0 auto">${cta}</div></div>`
    : `<div style="position:relative;z-index:2;display:flex;flex-direction:column;height:100%">
         <div style="display:flex;align-items:center;gap:8px">${mark}</div>
         <div style="margin-top:auto">${text}</div>
         <div style="margin-top:12px">${cta}</div>
       </div>`;

  // Rectangle background: hero image + readability gradient, or a subtle
  // accent-tinted brand wash so the middle is never a dead flat block.
  const rectBg = creative.imageUrl
    ? `<div style="position:absolute;inset:0;z-index:0;background:url('${esc(creative.imageUrl)}') center/cover no-repeat"></div>
       <div style="position:absolute;inset:0;z-index:1;background:linear-gradient(180deg, ${hexToRgba(creative.bgColor, 0.15)} 0%, ${hexToRgba(creative.bgColor, 0.86)} 74%)"></div>`
    : "";
  const bg = row
    ? creative.bgColor
    : creative.imageUrl
      ? creative.bgColor
      : `radial-gradient(120% 80% at 100% 0%, ${hexToRgba(creative.accentColor, 0.18)} 0%, ${hexToRgba(creative.bgColor, 0)} 60%), ${creative.bgColor}`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    a{text-decoration:none;display:block}
    .cp-ad{position:relative;width:${w}px;height:${h}px;background:${bg};font-family:${creative.fontFamily};
      border-radius:8px;padding:${isMobile ? "8px 10px" : "14px"};overflow:hidden;
      border:1px solid rgba(255,255,255,.08)}
  </style></head><body>
    <a class="cp-ad" href="${esc(clickUrl)}" target="_blank" rel="noopener sponsored">${rectBg}${inner}</a>
  </body></html>`;
}
