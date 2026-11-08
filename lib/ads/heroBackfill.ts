// Free ad heroes on c0mpute: CPU image generation (Z-Image-Turbo on a
// c0mpute worker, `diffusion.txt2img`) for campaigns that shipped with no hero.
//
// The request path never waits for this. Ad copy alone takes ~2 minutes on
// c0mpute, and an image is ~2 more, so /dashboard/ads/new keeps shipping the
// ad on its accent tint (or the advertiser's og:image) and this worker sweep
// fills the art in afterwards: one campaign per run, every creative of that
// campaign still missing an image gets the same hero, exactly as the request
// path would have set it.
//
// Paid gpt-image heroes stay where they were (AD_GENERATOR_PAID_IMAGES=1);
// this is the free tier that runs when nothing else drew one.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPrompt, uploadHero } from "./heroImage";

type Env = Record<string, string | undefined>;

// Read through a variable so nothing here can be inlined at build time.
function runtimeEnv(): Env {
  const e: Env = process.env;
  return e;
}

export type C0mputeImageTarget = { url: string; token: string };

/** The c0mpute gateway's image route, or null when none is configured. */
export function c0mputeImageTarget(env: Env = runtimeEnv()): C0mputeImageTarget | null {
  if (/^(0|off|false|no)$/i.test((env.AD_HERO_C0MPUTE ?? "").trim())) return null;
  const base = (env.C0MPUTE_SPEECH_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.C0MPUTE_SPEECH_TOKEN ?? "").trim();
  if (!base || !token) return null;
  return { url: `${base}/v1/images`, token };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The gateway runs the auction and retries other workers itself; a 6-core
// worker can need ~5 minutes per image.
const GENERATE_TIMEOUT_MS = 14 * 60 * 1000;

export class C0mputeImageError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** One 768x512 (3:2, the hero's shape) image from a c0mpute CPU worker. */
export async function generateC0mputeImage(
  prompt: string,
  target: C0mputeImageTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const res = await fetchImpl(target.url, {
    method: "POST",
    headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: prompt.slice(0, 2000), width: 768, height: 512 }),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new C0mputeImageError(`c0mpute image ${res.status}: ${detail}`, res.status);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new C0mputeImageError("c0mpute image: not a PNG", 502);
  }
  return bytes;
}

export function domainOf(url: string | null | undefined): string {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

type Candidate = {
  campaign_id: string;
  headline: string | null;
  body: string | null;
  bg_color: string | null;
  accent_color: string | null;
  ad_campaigns: { destination_url: string | null; status: string | null } | null;
};

// Per-process memory of what failed, so a bad campaign or an empty network is
// not retried every tick. Lost on restart, which is fine: it only rate-limits.
const campaignRetryAt = new Map<string, number>();
let networkRetryAt = 0;
const CAMPAIGN_BACKOFF_MS = 6 * 60 * 60 * 1000;
const NETWORK_BACKOFF_MS = 15 * 60 * 1000;
const LOOKBACK_DAYS = 30;

export type HeroBackfillResult = {
  skipped?: "not_configured" | "network_backoff" | "nothing_to_do";
  campaignId?: string;
  heroUrl?: string;
  creativesUpdated?: number;
  error?: string;
};

/**
 * Give one campaign that has no hero a c0mpute-drawn one. Never throws.
 */
export async function backfillAdHeroes(
  supabase: SupabaseClient,
  opts: { env?: Env; now?: number; fetchImpl?: typeof fetch } = {},
): Promise<HeroBackfillResult> {
  const target = c0mputeImageTarget(opts.env);
  if (!target) return { skipped: "not_configured" };
  const now = opts.now ?? Date.now();
  if (now < networkRetryAt) return { skipped: "network_backoff" };

  const since = new Date(now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("ad_creatives")
    .select("campaign_id, headline, body, bg_color, accent_color, ad_campaigns!inner(destination_url, status)")
    .is("image_url", null)
    .eq("status", "ready")
    .in("ad_campaigns.status", ["active", "pending_review", "draft"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return { error: `select: ${error.message}` };

  const pick = ((data ?? []) as unknown as Candidate[]).find(
    (row) => (campaignRetryAt.get(row.campaign_id) ?? 0) <= now,
  );
  if (!pick) return { skipped: "nothing_to_do" };

  const domain = domainOf(pick.ad_campaigns?.destination_url);
  const prompt = buildPrompt(
    { title: "", description: "", domain } as Parameters<typeof buildPrompt>[0],
    {
      headline: pick.headline ?? "",
      body: pick.body ?? "",
      bgColor: pick.bg_color ?? "#0b0d10",
      accentColor: pick.accent_color ?? "#6ee7b7",
    },
  );

  let bytes: Buffer;
  try {
    bytes = await generateC0mputeImage(prompt, target, opts.fetchImpl);
  } catch (err) {
    const status = err instanceof C0mputeImageError ? err.status : 0;
    // 503 = no worker free / none online: back off the whole sweep, not this campaign.
    if (status === 503 || status === 0) networkRetryAt = now + NETWORK_BACKOFF_MS;
    else campaignRetryAt.set(pick.campaign_id, now + CAMPAIGN_BACKOFF_MS);
    return { campaignId: pick.campaign_id, error: err instanceof Error ? err.message : String(err) };
  }

  const heroUrl = await uploadHero(bytes);
  if (!heroUrl) {
    campaignRetryAt.set(pick.campaign_id, now + CAMPAIGN_BACKOFF_MS);
    return { campaignId: pick.campaign_id, error: "upload failed" };
  }

  const { data: updated, error: updateError } = await supabase
    .from("ad_creatives")
    .update({ image_url: heroUrl })
    .eq("campaign_id", pick.campaign_id)
    .is("image_url", null)
    .select("id");
  if (updateError) {
    campaignRetryAt.set(pick.campaign_id, now + CAMPAIGN_BACKOFF_MS);
    return { campaignId: pick.campaign_id, heroUrl, error: `update: ${updateError.message}` };
  }
  return { campaignId: pick.campaign_id, heroUrl, creativesUpdated: updated?.length ?? 0 };
}

/** Test hook: forget backoff state. */
export function resetHeroBackfillState() {
  campaignRetryAt.clear();
  networkRetryAt = 0;
}
