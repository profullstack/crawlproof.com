import crypto from "node:crypto";
import type OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { smartFetch } from "@/lib/onion";
import { serviceClient } from "@/lib/supabase/service";
import type { SiteBrand } from "./brand";

// The ad hero image shown behind the Medium Rectangle. Chooses, in order:
//   1. a gpt-image-2.5 hero generated from the brand + ad copy, uploaded to the
//      public ad-assets bucket — purpose-built ad art reads far better than a
//      site's share image, so we prefer it.
//   2. the advertiser's own og:image / share image (free, already hosted) as a
//      fallback when AI is unavailable or generation fails.
// Best-effort throughout: any failure returns null and the ad falls back to the
// accent-tinted wash, never a broken image.

const ASSET_BUCKET = "ad-assets";
// gpt-image-1 is shut down by OpenAI on 2026-10-23 (#346).
const IMAGE_MODEL = "gpt-image-2.5-sunburst";
const VALIDATE_TIMEOUT_MS = 4000;
const MIN_IMAGE_BYTES = 2000; // <2KB is almost certainly a tracking pixel/placeholder

export type AdHeroCopy = {
  headline: string;
  body: string;
  bgColor: string;
  accentColor: string;
};

// Verify a URL responds 2xx with a real image body (not a 1px pixel). We read
// the body since some CDNs omit a length header; capped by the timeout.
async function isUsableImage(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await smartFetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { Accept: "image/*,*/*", "User-Agent": "CrawlProofAdBot/1.0" },
    });
    if (!res.ok) return false;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.startsWith("image/")) {
      void res.body?.cancel().catch(() => {});
      return false;
    }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len && len < MIN_IMAGE_BYTES) {
      void res.body?.cancel().catch(() => {});
      return false;
    }
    if (!len) {
      const buf = await res.arrayBuffer();
      return buf.byteLength >= MIN_IMAGE_BYTES;
    }
    void res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// One house look for every hero: launch-grade key art for the agentic AI era,
// so a network of very different sites still reads as one premium ad product.
const ART_DIRECTION = [
  "Art direction: flagship-launch quality, cinematic 3D render with photoreal materials,",
  "volumetric light, subtle holographic interface glints and luminous data threads",
  "suggesting AI agents at work, shallow depth of field, one crisp high-detail focal",
  "subject, refined editorial composition.",
].join(" ");

const FRAMING = [
  "Clear negative space along the bottom for an overlaid caption.",
  "No text, no letters, no logos, no watermarks, no UI chrome. Landscape 3:2.",
].join(" ");

export function buildPrompt(brand: SiteBrand, copy: AdHeroCopy): string {
  const subject = [brand.title, brand.description].filter(Boolean).join(" — ");
  return [
    "Premium key art for a display ad, made for the agentic AI era.",
    `Product: ${subject || brand.domain}.`,
    `Ad message: "${copy.headline}"${copy.body ? ` (${copy.body})` : ""}.`,
    ART_DIRECTION,
    `Palette built around deep background ${copy.bgColor} and accent ${copy.accentColor}.`,
    FRAMING,
  ].join(" ");
}

// The retry when the safety system refuses the subject prompt. Advertiser copy
// trips it on harmless products ("zombie love story" reads as violence, and is
// blocked at the output stage), so this one carries no copy at all: just the
// domain, the palette and an abstract focal object.
export function buildSafePrompt(brand: SiteBrand, copy: AdHeroCopy): string {
  return [
    "Premium key art for a display ad, made for the agentic AI era.",
    `Product category: a web product (${brand.domain}).`,
    ART_DIRECTION,
    "The focal subject is an abstract sculptural object; calm and friendly in tone; no people.",
    `Palette built around deep background ${copy.bgColor} and accent ${copy.accentColor}.`,
    FRAMING,
  ].join(" ");
}

function isModerationBlock(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === "moderation_blocked" || /safety system/i.test(e?.message ?? "");
}

async function generateOnce(openai: OpenAI, prompt: string): Promise<Buffer | null> {
  const res = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt,
    size: "1536x1024",
    quality: "high",
    n: 1,
  });
  const b64 = res.data?.[0]?.b64_json;
  return b64 ? Buffer.from(b64, "base64") : null;
}

async function generateAiHero(
  openai: OpenAI,
  brand: SiteBrand,
  copy: AdHeroCopy,
): Promise<Buffer | null> {
  try {
    return await generateOnce(openai, buildPrompt(brand, copy));
  } catch (err) {
    if (!isModerationBlock(err)) {
      console.warn("[ads] hero image gen failed", err instanceof Error ? err.message : err);
      return null;
    }
    console.warn("[ads] hero prompt refused by the safety system; retrying abstract");
  }
  try {
    return await generateOnce(openai, buildSafePrompt(brand, copy));
  } catch (err) {
    console.warn("[ads] hero image gen failed", err instanceof Error ? err.message : err);
    return null;
  }
}

// An app icon is not a share image: a 512px square logo stretched behind a
// banner is what an ad looked like when generation failed and og:image was the
// site's icon (pwamart's apps all point og:image at /icon-512.png).
export function looksLikeIcon(url: string): boolean {
  return /(^|[\/_-])(icon|favicon|apple-touch|logo)[^\/]*\.(png|jpe?g|webp|svg|ico)(\?|$)/i.test(url);
}

// Heroes are server-generated ad art, not user uploads. The ad-assets bucket's
// storage RLS only lets an authenticated user write under their own `${uid}/`
// prefix, so a user-scoped client can't write to `heroes/` (it fails with "new
// row violates row-level security policy"). Upload with the service-role client,
// which bypasses RLS.
async function uploadHero(bytes: Buffer): Promise<string | null> {
  const svc = serviceClient();
  const path = `heroes/${crypto.randomUUID()}.png`;
  const { error } = await svc.storage.from(ASSET_BUCKET).upload(path, bytes, {
    contentType: "image/png",
    upsert: false,
  });
  if (error) {
    console.warn("[ads] hero upload failed", error.message);
    return null;
  }
  return svc.storage.from(ASSET_BUCKET).getPublicUrl(path).data.publicUrl;
}

// Resolve the hero image URL for a set of ad creatives. A gpt-image-2.5 hero
// first (purpose-built ad art), then the advertiser's og:image as a fallback
// when AI is unavailable/fails. Returns null if neither works — the renderer
// then uses the accent-tinted fallback.
export async function resolveAdHeroImage(args: {
  brand: SiteBrand;
  copy: AdHeroCopy;
  openai: OpenAI | null;
  // Presence signals that upload hosting is available; the hero itself is
  // uploaded with the service-role client (see uploadHero).
  supabase: SupabaseClient;
}): Promise<{ url: string; source: "og" | "ai" } | null> {
  const { brand, copy, openai } = args;

  if (openai) {
    const bytes = await generateAiHero(openai, brand, copy);
    if (bytes) {
      const url = await uploadHero(bytes);
      if (url) return { url, source: "ai" };
    }
  }

  if (brand.ogImage && !looksLikeIcon(brand.ogImage) && (await isUsableImage(brand.ogImage))) {
    return { url: brand.ogImage, source: "og" };
  }

  return null;
}
