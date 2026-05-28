// Image attachment for social autoposts. Tries the article's og:image
// first (free, on-brand). If missing, optionally generates one via
// gpt-image-1 — but only when the project's image_cadence says we're
// due for one, so the feed doesn't read as AI spam.

import OpenAI from "openai";
import * as cheerio from "cheerio";
import type { SupabaseClient } from "@supabase/supabase-js";

const FETCH_TIMEOUT_MS = 8_000;
const MIN_OG_IMAGE_BYTES = 2_000; // <2KB is almost certainly a placeholder.
const BUCKET = "sp-images";
const IMAGE_MODEL = "gpt-image-1";
const IMAGE_SIZE = "1024x1024";
const IMAGE_QUALITY: "low" | "medium" | "high" | "auto" = "medium";

export type ImageAttachment = {
  url: string;
  source: "og" | "ai";
};

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
}): Promise<Buffer | null> {
  const { openai, articleTitle, brandVoice } = args;
  const brand = brandVoice.trim()
    ? `Brand context: ${brandVoice.trim()}.`
    : "";
  const prompt = [
    `Editorial social-share image for an article titled: "${articleTitle}".`,
    brand,
    "Single focal subject, photographic or illustrative, dramatic lighting, scroll-stopping. Square 1:1 composition that reads well at thumbnail size. No on-image text, no logos, no AI-style geometric abstract shapes.",
  ]
    .filter(Boolean)
    .join(" ");
  try {
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
  allowAi: boolean;
}): Promise<ImageAttachment | null> {
  const { supabase, openai, feedItemId, articleUrl, articleTitle, brandVoice, allowAi } =
    args;

  const og = await fetchOgImage(articleUrl);
  if (og) {
    const url = await uploadSocialImage(supabase, feedItemId, og.bytes, og.contentType);
    if (url) return { url, source: "og" };
  }

  if (!allowAi || !openai) return null;

  const bytes = await generateSocialImage({ openai, articleTitle, brandVoice });
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
