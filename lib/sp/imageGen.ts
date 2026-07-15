// Image attachment for social autoposts. Tries the article's og:image
// first (free, on-brand). If missing, optionally generates one via
// gpt-image-2 — but only when the project's image_cadence says we're
// due for one, so the feed doesn't read as AI spam.

import OpenAI from "openai";
import * as cheerio from "cheerio";
import type { SupabaseClient } from "@supabase/supabase-js";

const FETCH_TIMEOUT_MS = 8_000;
const MIN_OG_IMAGE_BYTES = 2_000; // <2KB is almost certainly a placeholder.
const BUCKET = "sp-images";
const IMAGE_MODEL = "gpt-image-2";
const IMAGE_QUALITY: "low" | "medium" | "high" | "auto" = "high";

export type ImageAttachment = {
  url: string;
  source: "og" | "ai";
};

export type ImageStyle =
  | "editorial"
  | "infographic"
  | "quote_card"
  | "diagram"
  | "screenshot";

// Style → (size, prompt builder). Sizes are picked from gpt-image-2's
// native options (1024x1024, 1536x1024, 1024x1536) so we don't pay for
// crops.
type StyleSpec = {
  size: "1024x1024" | "1536x1024" | "1024x1536";
  buildPrompt: (args: { articleTitle: string; brandContext: string }) => string;
};

const STYLE_SPECS: Record<ImageStyle, StyleSpec> = {
  editorial: {
    size: "1024x1024",
    buildPrompt: ({ articleTitle, brandContext }) =>
      [
        `Editorial social-share image for an article titled: "${articleTitle}".`,
        brandContext,
        "Single focal subject, photographic or illustrative, dramatic lighting, scroll-stopping. Square 1:1 composition that reads well at thumbnail size. No on-image text, no logos, no AI-style geometric abstract shapes.",
      ]
        .filter(Boolean)
        .join(" "),
  },
  infographic: {
    size: "1536x1024",
    buildPrompt: ({ articleTitle, brandContext }) =>
      [
        `Bold two-panel comparison infographic for an article titled: "${articleTitle}".`,
        brandContext,
        "Top: a short uppercase headline (max 6 words) that captures the article's claim. Below it: two clearly separated panels. Left panel shows the 'before' / problem state in a muted grey-blue palette with simple iconography (clocks, calendars, paper documents, banks). Right panel shows the 'after' / solution state in a vivid blue-green neon palette with glowing iconography (network nodes, lightning bolts, checkmarks, fast arrows). A large arrow points from left to right between them. Crisp sans-serif on-image text labels under each panel (2-3 short phrases). Flat illustrative style, scroll-stopping, no photographic elements, no logos, no fake brand names. Landscape 3:2.",
      ]
        .filter(Boolean)
        .join(" "),
  },
  quote_card: {
    size: "1024x1024",
    buildPrompt: ({ articleTitle, brandContext }) =>
      [
        `Minimalist quote card centred on the headline: "${articleTitle}".`,
        brandContext,
        "Headline rendered as the dominant element — large, bold, well-kerned sans-serif, broken across at most 4 lines. Soft single-colour or subtle gradient background; one understated decorative motif (a thin underline, a small geometric flourish, or a faint texture) — nothing busy. No author photo, no logos, no quotation marks unless they support the typography. Square 1:1. Reads cleanly at thumbnail size.",
      ]
        .filter(Boolean)
        .join(" "),
  },
  diagram: {
    size: "1536x1024",
    buildPrompt: ({ articleTitle, brandContext }) =>
      [
        `Clean technical diagram illustrating the concept in: "${articleTitle}".`,
        brandContext,
        "Labelled boxes / nodes connected by directional arrows. Architecture-diagram aesthetic: thin outlined shapes, monospace or geometric sans-serif labels, a restrained 2-3 colour palette with one accent colour for emphasis. Light background. Each box has a short readable label (1-3 words). No drop shadows, no glow effects, no photographic elements. Landscape 3:2.",
      ]
        .filter(Boolean)
        .join(" "),
  },
  screenshot: {
    size: "1536x1024",
    buildPrompt: ({ articleTitle, brandContext }) =>
      [
        `Plausible product UI screenshot mocking up the feature described in: "${articleTitle}".`,
        brandContext,
        "Looks like a real SaaS dashboard or app screenshot — a header bar, a sidebar or tab strip, a main content area with cards/tables/charts, realistic spacing and typography. Use real-looking but fictional copy (no Lorem Ipsum). Subtle drop shadows, modern light-mode UI palette. No browser chrome, no mouse cursor, no people. Landscape 3:2, reads well as a social preview.",
      ]
        .filter(Boolean)
        .join(" "),
  },
};

export function imageStyleOptions(): ImageStyle[] {
  return Object.keys(STYLE_SPECS) as ImageStyle[];
}

// A stored image-style preference: a concrete style, or "rotate" to cycle
// through every style (one per post).
export type ImageStylePref = ImageStyle | "rotate";

// Resolve a stored preference to a concrete style. "rotate" picks one
// deterministically from the seed (the feed item id) so re-renders are
// stable while different items cycle through the full set.
export function resolveImageStyle(pref: ImageStylePref, seed: string): ImageStyle {
  if (pref !== "rotate") return pref;
  const options = imageStyleOptions();
  const hex = seed.replace(/-/g, "").slice(0, 8);
  const n = parseInt(hex, 16);
  const idx = Number.isFinite(n) ? n % options.length : 0;
  return options[idx] ?? "editorial";
}

// Decides whether THIS feed item should get an image. cadence = 0 means
// never; cadence = N means roughly 1 in N. Decision is deterministic from
// the item id so re-renders give the same answer.
export function shouldAttachImage(itemId: string, cadence: number): boolean {
  if (cadence <= 0) return false;
  if (cadence === 1) return true;
  // 8 hex chars = 4 bytes = ~4B distinct values, way more than cadence.
  const hex = itemId.replace(/-/g, "").slice(0, 8);
  const n = parseInt(hex, 16);
  if (!Number.isFinite(n)) return false;
  return n % cadence === 0;
}

export async function fetchOgImage(
  articleUrl: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  let pageHtml: string;
  try {
    pageHtml = await fetchText(articleUrl, "text/html");
  } catch {
    return null;
  }
  const $ = cheerio.load(pageHtml);
  const candidates = [
    $('meta[property="og:image"]').attr("content"),
    $('meta[property="og:image:url"]').attr("content"),
    $('meta[name="twitter:image"]').attr("content"),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  if (candidates.length === 0) return null;
  const imageUrl = absolutize(candidates[0], articleUrl);
  if (!imageUrl) return null;

  try {
    const { bytes, contentType } = await fetchBinary(imageUrl);
    if (bytes.length < MIN_OG_IMAGE_BYTES) return null;
    if (!contentType.startsWith("image/")) return null;
    return { bytes, contentType };
  } catch {
    return null;
  }
}

export async function generateSocialImage(args: {
  openai: OpenAI;
  articleTitle: string;
  brandVoice: string;
  style: ImageStyle;
}): Promise<Buffer | null> {
  const { openai, articleTitle, brandVoice, style } = args;
  const spec = STYLE_SPECS[style] ?? STYLE_SPECS.editorial;
  const brandContext = brandVoice.trim()
    ? `Brand context: ${brandVoice.trim()}.`
    : "";
  const prompt = spec.buildPrompt({ articleTitle, brandContext });
  try {
    const res = await openai.images.generate({
      model: IMAGE_MODEL,
      prompt,
      size: spec.size,
      quality: IMAGE_QUALITY,
      n: 1,
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) return null;
    return Buffer.from(b64, "base64");
  } catch (err) {
    console.warn(
      "[sp] image gen failed",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function uploadSocialImage(
  supabase: SupabaseClient<any>,
  feedItemId: string,
  bytes: Buffer,
  contentType: string,
): Promise<string | null> {
  const ext = contentType.includes("png")
    ? "png"
    : contentType.includes("webp")
      ? "webp"
      : "jpg";
  const path = `${feedItemId}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType,
    upsert: true,
  });
  if (error) {
    console.warn("[sp] image upload failed", error.message);
    return null;
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// One-stop: returns an ImageAttachment if we should and could attach
// one. Caller is responsible for the cadence decision via
// shouldAttachImage — this just executes the og→ai pipeline.
export async function resolveImage(args: {
  supabase: SupabaseClient<any>;
  openai: OpenAI | null;
  feedItemId: string;
  articleUrl: string;
  articleTitle: string;
  brandVoice: string;
  style: ImageStyle;
  allowAi: boolean;
}): Promise<ImageAttachment | null> {
  const {
    supabase,
    openai,
    feedItemId,
    articleUrl,
    articleTitle,
    brandVoice,
    style,
    allowAi,
  } = args;

  // Stylised images (infographic / diagram / quote_card / screenshot)
  // are the whole point of choosing the style — falling back to the
  // article's og:image would defeat that. Only short-circuit to og for
  // 'editorial', where any reasonable hero image will do.
  if (style === "editorial") {
    const og = await fetchOgImage(articleUrl);
    if (og) {
      const url = await uploadSocialImage(
        supabase,
        feedItemId,
        og.bytes,
        og.contentType,
      );
      if (url) return { url, source: "og" };
    }
  }

  if (!allowAi || !openai) return null;

  const bytes = await generateSocialImage({
    openai,
    articleTitle,
    brandVoice,
    style,
  });
  if (!bytes) return null;
  const url = await uploadSocialImage(supabase, feedItemId, bytes, "image/png");
  if (!url) return null;
  return { url, source: "ai" };
}

async function fetchText(url: string, accept: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        accept,
        "user-agent": "CrawlProofSocialImage/1.0",
      },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBinary(
  url: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "CrawlProofSocialImage/1.0" },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return {
      bytes: Buffer.from(buf),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  } finally {
    clearTimeout(timer);
  }
}

function absolutize(maybeRelative: string, base: string): string | null {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}
