import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
// The SDK's zod helper imports from "zod/v4" internally and calls
// z.toJSONSchema() — a v4-only API. Plain "zod" gives v3 schemas the
// helper can't read. Mirrors lib/lx/detectBlog.ts.
import { z } from "zod/v4";
import { env } from "../env";
import { generateStructuredOutput } from "../lx/backendAi";

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 200_000;
const MAX_TEXT_CHARS = 8000;
const UA =
  "Mozilla/5.0 (compatible; CrawlProofBrandBot/1.0; +https://crawlproof.com)";
// Fast/cheap — extraction doesn't need a frontier model. Matches detectBlog.
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// Allowed values mirror the form's selects in social-profile.tsx and the
// server-side validation in saveSocialProfile (ALLOWED_TONES / ALLOWED_IMAGE_STYLES).
export const BRAND_TONES = [
  "casual",
  "professional",
  "witty",
  "authoritative",
  "friendly",
  "playful",
  "technical",
] as const;

export const BRAND_IMAGE_STYLES = [
  "editorial",
  "infographic",
  "quote_card",
  "diagram",
  "screenshot",
] as const;

export const BrandProfileSchema = z.object({
  brandVoice: z
    .string()
    .max(2000)
    .describe(
      "1-3 sentences describing who is writing: their role/expertise, personality, and who they write for. Inferred from the site's actual copy. Empty string if the site gives no signal.",
    ),
  tone: z
    .enum(BRAND_TONES)
    .describe("The single closest overall tone of the brand's writing."),
  defaultHashtags: z
    .array(z.string())
    .max(12)
    .describe(
      "Up to ~6 topical hashtags relevant to the brand (words only, no leading #). Empty array if unclear.",
    ),
  imageCadence: z
    .number()
    .int()
    .min(0)
    .max(50)
    .describe("How often social posts should include an image: 0=never, 1=every post, 3=~1 in 3. Default 3 unless the brand is clearly text-only."),
  imageStyle: z
    .enum(BRAND_IMAGE_STYLES)
    .describe("The image style that best fits this brand's content."),
  customInstructions: z
    .string()
    .max(2000)
    .describe(
      "Optional brand-specific do/don't directives you can justify from the site (e.g. product names to use, audience). Empty string if none.",
    ),
});

export type BrandProfileExtract = z.infer<typeof BrandProfileSchema>;

const SYSTEM_PROMPT = [
  "You configure a social-media brand profile by analysing a company's website.",
  "Infer the brand's voice, tone, hashtags, and image preferences ONLY from the provided site content — never invent facts.",
  "Always pick the closest allowed enum value for tone and imageStyle.",
  "Keep brandVoice concise and concrete. Leave text fields empty rather than guessing wildly.",
].join(" ");

function normalizeUrl(raw: string): string {
  const u = raw.trim();
  if (!u) return u;
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch =
    html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    ) ||
    html.match(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
    );

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  const cleanBody = decodeEntities(body).replace(/\s+/g, " ").trim();
  const title = titleMatch
    ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim()
    : "";
  const desc = descMatch ? decodeEntities(descMatch[1]).trim() : "";

  const text = (desc ? `Meta description: ${desc}\n\n` : "") + cleanBody;
  return { title, text: text.slice(0, MAX_TEXT_CHARS) };
}

/** Fetch a site's homepage HTML and reduce it to plain text (title + meta + body). */
export async function fetchSiteText(
  rawUrl: string,
): Promise<{ title: string; text: string }> {
  const url = normalizeUrl(rawUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return { title: "", text: "" };
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("text/html")) return { title: "", text: "" };

    // Stream and cap so a huge page can't blow up memory.
    const reader = res.body?.getReader();
    let html: string;
    if (!reader) {
      html = (await res.text()).slice(0, MAX_BYTES);
    } else {
      const decoder = new TextDecoder();
      let buf = "";
      let read = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          read += value.byteLength;
          buf += decoder.decode(value, { stream: true });
          if (read >= MAX_BYTES) break;
        }
      }
      try {
        await reader.cancel();
      } catch {
        // body may already be closed
      }
      html = buf;
    }
    return htmlToText(html);
  } catch {
    return { title: "", text: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the LLM to derive a brand profile from fetched site content. */
export async function extractBrandProfile(args: {
  url: string;
  name?: string | null;
  title: string;
  siteText: string;
}): Promise<BrandProfileExtract> {
  const anthropicApiKey = env.anthropicApiKey;
  const openaiApiKey = env.openaiApiKey;
  if (!anthropicApiKey && !openaiApiKey) {
    throw new Error("OPENAI_API_KEY or ANTHROPIC_API_KEY not set");
  }

  const user = [
    args.name ? `Brand name: ${args.name}` : "",
    `Website: ${args.url}`,
    args.title ? `Page title: ${args.title}` : "",
    "",
    "Site content:",
    args.siteText || "(no readable content)",
  ]
    .filter(Boolean)
    .join("\n");

  const generated = await generateStructuredOutput({
    name: "sp_brand_profile",
    schema: BrandProfileSchema,
    system: SYSTEM_PROMPT,
    user,
    anthropic: anthropicApiKey
      ? new Anthropic({ apiKey: anthropicApiKey })
      : null,
    openai: openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null,
    preference: env.backendAiProvider,
    anthropicModel: HAIKU_MODEL,
    openaiModel: env.backendAiOpenaiModel,
    maxTokens: 1500,
    // Haiku 4.5 rejects Anthropic's `effort` parameter (see detectBlog.ts).
    anthropicEffort: false,
  });
  return generated.output;
}
