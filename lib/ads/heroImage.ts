import crypto from "node:crypto";
import type OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { smartFetch } from "@/lib/onion";
import { serviceClient } from "@/lib/supabase/service";
import type { SiteBrand } from "./brand";

// The ad hero image shown behind the Medium Rectangle. Chooses, in order:
//   1. a gpt-image-1 hero generated from the brand + ad copy, uploaded to the
//      public ad-assets bucket — purpose-built ad art reads far better than a
//      site's share image, so we prefer it.
//   2. the advertiser's own og:image / share image (free, already hosted) as a
//      fallback when AI is unavailable or generation fails.
// Best-effort throughout: any failure returns null and the ad falls back to the
// accent-tinted wash, never a broken image.

const ASSET_BUCKET = "ad-assets";
const IMAGE_MODEL = "gpt-image-1";
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

function buildPrompt(brand: SiteBrand, copy: AdHeroCopy): string {
  const subject = [brand.title, brand.description].filter(Boolean).join(" — ");
  return [
    `Advertising hero image for a display ad promoting: ${subject || brand.domain}.`,
    `The ad's message is "${copy.headline}"${copy.body ? ` (${copy.body})` : ""}.`,
    `On-brand palette built around background ${copy.bgColor} and accent ${copy.accentColor}.`,
    "A single striking focal subject, photographic or richly illustrative, dramatic lighting,",
    "scroll-stopping, with clear negative space toward the bottom for an overlaid caption.",
    "No on-image text, no words, no logos, no watermarks, no UI chrome. Landscape 3:2.",
  ].join(" ");
}

async function generateAiHero(
  openai: OpenAI,
  brand: SiteBrand,
  copy: AdHeroCopy,
): Promise<Buffer | null> {
  try {
    const res = await openai.images.generate({
      model: IMAGE_MODEL,
      prompt: buildPrompt(brand, copy),
      size: "1536x1024",
      quality: "medium",
      n: 1,
    });
    const b64 = res.data?.[0]?.b64_json;
    return b64 ? Buffer.from(b64, "base64") : null;
  } catch (err) {
    console.warn("[ads] hero image gen failed", err instanceof Error ? err.message : err);
    return null;
  }
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

// Resolve the hero image URL for a set of ad creatives. A gpt-image-1 hero
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

  if (brand.ogImage && (await isUsableImage(brand.ogImage))) {
    return { url: brand.ogImage, source: "og" };
  }

  return null;
}
