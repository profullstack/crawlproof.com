import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
// The SDK zod helper needs v4 schemas (z.toJSONSchema). Mirrors brandProfileFetch.
import { z } from "zod/v4";
import { env } from "@/lib/env";
import { generateStructuredOutput } from "@/lib/lx/backendAi";
import { extractSiteBrand, type SiteBrand } from "./brand";

// Copy is generated once per URL by a frontier-ish model; sizes are rendered
// from the same copy set. Cheap, fast, and editable — no image-gen required.
const CLAUDE_MODEL = "claude-sonnet-4-6";
const OPENAI_MODEL = "gpt-5-mini";

export const AD_FORMATS = [
  { id: "banner_300x250", label: "Medium Rectangle", w: 300, h: 250 },
  { id: "banner_728x90", label: "Leaderboard", w: 728, h: 90 },
  { id: "banner_320x50", label: "Mobile Banner", w: 320, h: 50 },
] as const;

export type AdFormatId = (typeof AD_FORMATS)[number]["id"];
export const AD_FORMAT_IDS = AD_FORMATS.map((f) => f.id) as AdFormatId[];

export function formatSpec(id: AdFormatId) {
  return AD_FORMATS.find((f) => f.id === id) ?? AD_FORMATS[0];
}

export type AdCreative = {
  format: AdFormatId;
  headline: string;
  body: string;
  ctaText: string;
  bgColor: string;
  fgColor: string;
  accentColor: string;
  fontFamily: string;
  logoUrl: string | null;
  imageUrl: string | null;
};

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
  body: z
    .string()
    .max(90)
    .describe("One concrete benefit line. No hype, no exclamation spam."),
  ctaText: z
    .string()
    .max(18)
    .describe("Button label, e.g. 'Try it free', 'Get started', 'Learn more'."),
  bgColor: z.string().describe("Background hex like #0b0d10 — on-brand, good contrast with fg."),
  fgColor: z.string().describe("Text hex with strong contrast against bg."),
  accentColor: z.string().describe("Accent/CTA hex — the brand's signature colour if visible."),
});
type AdCopy = z.infer<typeof CopySchema>;

const SYSTEM_PROMPT = [
  "You are a senior performance-marketing copywriter and brand designer.",
  "Given a company's website content and detected brand colours, write a single",
  "display-ad concept: a headline, a tiny mobile headline, one benefit line, a CTA,",
  "and an on-brand colour trio (background, foreground, accent).",
  "Rules: infer voice and value proposition ONLY from the provided content — never",
  "invent features, prices, or claims. Keep it concrete and specific to this product.",
  "Colours must be readable: high contrast between background and foreground.",
  "Prefer the site's real brand/accent colour when the palette makes it obvious.",
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

function copyToCreatives(brand: SiteBrand, copy: AdCopy): AdCreative[] {
  const bg = safeHex(copy.bgColor, brand.themeColor && HEX.test(brand.themeColor) ? brand.themeColor : "#0b0d10");
  const fg = safeHex(copy.fgColor, "#e7e9ee");
  const accent = safeHex(copy.accentColor, brand.palette[0] ?? "#6ee7b7");
  const base = {
    bgColor: bg,
    fgColor: fg,
    accentColor: accent,
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    logoUrl: brand.logoUrl,
    imageUrl: null as string | null,
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

export async function generateAdCreatives(
  rawUrl: string,
): Promise<{ brand: SiteBrand; creatives: AdCreative[]; provider: string }> {
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

  return { brand, creatives: copyToCreatives(brand, output), provider };
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

// Self-contained HTML for a creative — used by the live preview and (Phase 2)
// the served ad unit inside an isolated iframe. clickUrl is the destination
// with ?ref= already applied.
export function renderCreativeHtml(creative: AdCreative, clickUrl: string): string {
  const { w, h } = formatSpec(creative.format);
  const isLeaderboard = creative.format === "banner_728x90";
  const isMobile = creative.format === "banner_320x50";
  const row = isLeaderboard || isMobile;
  const showBody = !isMobile;
  const logo = creative.logoUrl
    ? `<img src="${esc(creative.logoUrl)}" alt="" style="height:${isMobile ? 20 : 28}px;width:auto;border-radius:4px;flex:0 0 auto" />`
    : "";
  const cta = `<span style="background:${creative.accentColor};color:#04121a;font-weight:600;border-radius:6px;padding:${isMobile ? "4px 8px" : "7px 12px"};font-size:${isMobile ? 11 : 13}px;white-space:nowrap">${esc(creative.ctaText)}</span>`;

  const text = `
    <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
      <div style="font-weight:700;font-size:${isMobile ? 13 : isLeaderboard ? 16 : 18}px;line-height:1.15;color:${creative.fgColor};overflow:hidden;text-overflow:ellipsis;${isMobile ? "white-space:nowrap" : ""}">${esc(creative.headline)}</div>
      ${showBody ? `<div style="font-size:${isLeaderboard ? 12 : 13}px;line-height:1.3;color:${creative.fgColor};opacity:.8">${esc(creative.body)}</div>` : ""}
    </div>`;

  const inner = row
    ? `<div style="display:flex;align-items:center;gap:12px;width:100%">${logo}${text}<div style="margin-left:auto;flex:0 0 auto">${cta}</div></div>`
    : `<div style="display:flex;flex-direction:column;height:100%">
         <div style="display:flex;align-items:center;gap:8px">${logo}<span style="font-size:12px;color:${creative.fgColor};opacity:.7">${esc(creative.headline ? "" : "")}</span></div>
         <div style="margin-top:auto">${text}</div>
         <div style="margin-top:12px">${cta}</div>
       </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    a{text-decoration:none;display:block}
    .cp-ad{width:${w}px;height:${h}px;background:${creative.bgColor};font-family:${creative.fontFamily};
      border-radius:8px;padding:${isMobile ? "8px 10px" : "14px"};overflow:hidden;
      border:1px solid rgba(255,255,255,.08)}
  </style></head><body>
    <a class="cp-ad" href="${esc(clickUrl)}" target="_blank" rel="noopener sponsored">${inner}</a>
  </body></html>`;
}
