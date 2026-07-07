"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { isAllowedTargetUrl } from "@/lib/rateLimit";
import { getOrCreateDefaultOrg } from "@/lib/orgs";
import {
  generateAdCreatives,
  AD_FORMAT_IDS,
  type AdCreative,
  type AdFormatId,
} from "@/lib/ads/creative";
import type { SiteBrand } from "@/lib/ads/brand";
import { MIN_PAYOUT_CENTS, DEFAULT_BID_CREDITS } from "@/lib/ads/pricing";
import { createCryptoPayout } from "@/lib/coinpay";

const ASSET_BUCKET = "ad-assets";
const MAX_ASSET_BYTES = 2 * 1024 * 1024; // 2 MB

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Auto-generate ad creatives from a destination URL. No DB write — the client
// holds the result, lets the user edit/replace, then calls saveCampaign.
export async function previewAds(input: { url: string }): Promise<
  | { ok: true; brand: SiteBrand; creatives: AdCreative[]; provider: string; suggestedName: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const check = isAllowedTargetUrl(input.url);
  if (!check.ok) return { ok: false, error: check.reason };

  try {
    const { brand, creatives, provider } = await generateAdCreatives(check.url);
    return {
      ok: true,
      brand,
      creatives,
      provider,
      suggestedName: brand.title?.slice(0, 60) || domainOf(check.url),
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Could not generate ads for that URL.",
    };
  }
}

const ALLOWED_FORMATS = new Set<AdFormatId>(AD_FORMAT_IDS);
const HEX = /^#[0-9a-fA-F]{6}$/;

function cleanCreative(c: Partial<AdCreative>): AdCreative | null {
  if (!c.format || !ALLOWED_FORMATS.has(c.format)) return null;
  return {
    format: c.format,
    headline: (c.headline ?? "").slice(0, 80),
    body: (c.body ?? "").slice(0, 140),
    ctaText: (c.ctaText ?? "Learn more").slice(0, 24) || "Learn more",
    bgColor: HEX.test(c.bgColor ?? "") ? c.bgColor! : "#0b0d10",
    fgColor: HEX.test(c.fgColor ?? "") ? c.fgColor! : "#e7e9ee",
    accentColor: HEX.test(c.accentColor ?? "") ? c.accentColor! : "#6ee7b7",
    fontFamily: (c.fontFamily ?? "system-ui, sans-serif").slice(0, 200),
    logoUrl: c.logoUrl ?? null,
    imageUrl: c.imageUrl ?? null,
  };
}

// Persist a campaign + its (possibly edited) creatives. Starts as a draft;
// serving is a later phase.
export async function saveCampaign(input: {
  name: string;
  url: string;
  dailyBudgetCents: number;
  bidCredits?: number;
  brand?: SiteBrand | null;
  creatives: Partial<AdCreative>[];
}): Promise<{ ok: true; id: string; refSlug: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const check = isAllowedTargetUrl(input.url);
  if (!check.ok) return { ok: false, error: check.reason };

  const creatives = input.creatives
    .map(cleanCreative)
    .filter((c): c is AdCreative => c !== null);
  if (creatives.length === 0) return { ok: false, error: "No valid creatives to save." };

  const budget = Number.isFinite(input.dailyBudgetCents)
    ? Math.max(0, Math.round(input.dailyBudgetCents))
    : 500;
  // Bid in credits; clamp to a sane range. Defaults to the standard CPC.
  const bid = Number.isFinite(input.bidCredits)
    ? Math.min(200, Math.max(1, Math.round(input.bidCredits!)))
    : DEFAULT_BID_CREDITS;

  const org = await getOrCreateDefaultOrg({ userId: user.id, email: user.email });

  const payload: Record<string, unknown> = {
    owner_id: user.id,
    name: (input.name || domainOf(check.url)).slice(0, 120),
    destination_url: check.url,
    destination_domain: domainOf(check.url),
    daily_budget_cents: budget,
    bid_credits: bid,
    status: "draft",
    brand: input.brand ?? {},
  };
  if (org.id) payload.organization_id = org.id;

  let campaign = await supabase
    .from("ad_campaigns")
    .insert(payload)
    .select("id, ref_slug")
    .single();

  if (
    campaign.error &&
    org.id &&
    /organization_id|schema cache|column/i.test(campaign.error.message ?? "")
  ) {
    delete payload.organization_id;
    campaign = await supabase
      .from("ad_campaigns")
      .insert(payload)
      .select("id, ref_slug")
      .single();
  }
  if (campaign.error || !campaign.data) {
    return { ok: false, error: campaign.error?.message ?? "Failed to save campaign." };
  }

  const rows = creatives.map((c) => ({
    campaign_id: campaign.data!.id,
    owner_id: user.id,
    format: c.format,
    headline: c.headline,
    body: c.body,
    cta_text: c.ctaText,
    image_url: c.imageUrl,
    logo_url: c.logoUrl,
    bg_color: c.bgColor,
    fg_color: c.fgColor,
    accent_color: c.accentColor,
    font_family: c.fontFamily,
  }));
  const { error: cErr } = await supabase.from("ad_creatives").insert(rows);
  if (cErr) return { ok: false, error: cErr.message };

  revalidatePath("/ads");
  return { ok: true, id: campaign.data.id, refSlug: campaign.data.ref_slug };
}

// --- Campaign activation (advertiser) ---

const CAMPAIGN_STATUSES = new Set(["active", "paused", "draft"]);

export async function setCampaignStatus(input: {
  id: string;
  status: "active" | "paused" | "draft";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!CAMPAIGN_STATUSES.has(input.status)) return { ok: false, error: "Bad status." };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // Require at least one ready creative before going live.
  if (input.status === "active") {
    const { count } = await supabase
      .from("ad_creatives")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", input.id)
      .eq("status", "ready");
    if (!count) return { ok: false, error: "Add a creative before activating." };
  }

  const { error } = await supabase
    .from("ad_campaigns")
    .update({ status: input.status })
    .eq("id", input.id)
    .eq("owner_id", user.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/ads");
  return { ok: true };
}

// --- Publisher slots ---

export async function createSlot(input: {
  projectId: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // Monetization is owner-only — the broad projects RLS also allows org/member
  // reads, so scope explicitly to owner_id (payouts go to the slot owner).
  const { data: project } = await supabase
    .from("projects")
    .select("id, organization_id")
    .eq("id", input.projectId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!project) return { ok: false, error: "You can only monetize a site you own." };

  const payload: Record<string, unknown> = {
    project_id: project.id,
    owner_id: user.id,
    status: "inactive",
  };
  if (project.organization_id) payload.organization_id = project.organization_id;

  const { data, error } = await supabase
    .from("ad_slots")
    .insert(payload)
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Failed to create slot." };
  revalidatePath("/ads/slots");
  return { ok: true, id: data.id };
}

export async function setSlotStatus(input: {
  id: string;
  status: "active" | "paused" | "inactive";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  const { error } = await supabase
    .from("ad_slots")
    .update({ status: input.status })
    .eq("id", input.id)
    .eq("owner_id", user.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/ads/slots");
  return { ok: true };
}

export async function saveSlotPayout(input: {
  id: string;
  payoutAddress: string;
  payoutCurrency: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  const addr = input.payoutAddress.trim().slice(0, 200);
  const { error } = await supabase
    .from("ad_slots")
    .update({ payout_address: addr || null, payout_currency: input.payoutCurrency.trim().toLowerCase() || null })
    .eq("id", input.id)
    .eq("owner_id", user.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/ads/slots");
  return { ok: true };
}

// Request a crypto withdrawal of a slot's accrued earnings. Records an
// ad_payouts row; outbound CoinPay execution is processed separately.
export async function requestPayout(input: {
  slotId: string;
}): Promise<{ ok: true; amountCents: number } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: slot } = await supabase
    .from("ad_slots")
    .select("id, payout_address, payout_currency")
    .eq("id", input.slotId)
    .maybeSingle();
  if (!slot) return { ok: false, error: "Slot not found." };
  if (!slot.payout_address) return { ok: false, error: "Add a payout wallet address first." };

  // Available = accrued earnings − already-requested/sent/confirmed payouts.
  const [{ data: accruals }, { data: payouts }] = await Promise.all([
    supabase.from("ad_ledger").select("amount_cents").eq("slot_id", input.slotId).eq("kind", "publisher_accrual"),
    supabase.from("ad_payouts").select("amount_cents, status").eq("slot_id", input.slotId),
  ]);
  const earned = (accruals ?? []).reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  const withdrawn = (payouts ?? [])
    .filter((p) => p.status !== "failed")
    .reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  const available = earned - withdrawn;

  if (available < MIN_PAYOUT_CENTS) {
    return { ok: false, error: `Minimum withdrawal is ${(MIN_PAYOUT_CENTS / 100).toFixed(2)}. You have ${(available / 100).toFixed(2)}.` };
  }

  // Solvency backstop: cumulative publisher payouts can never exceed cumulative
  // real advertiser cash in. The floor-rate math already guarantees this per
  // click; this is belt-and-braces against pricing/promo misconfiguration.
  const svc = serviceClient();
  const [{ data: deposits }, { data: allPayouts }] = await Promise.all([
    svc.from("credit_purchases").select("amount_cents").eq("status", "complete"),
    svc.from("ad_payouts").select("amount_cents, status"),
  ]);
  const cashIn = (deposits ?? []).reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  const paidOut = (allPayouts ?? [])
    .filter((p) => p.status !== "failed")
    .reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  if (paidOut + available > cashIn) {
    return {
      ok: false,
      error: "Withdrawals are briefly paused for reconciliation. Please try again later.",
    };
  }

  const currency = slot.payout_currency || "usdc_pol";
  const { data: payout, error } = await supabase
    .from("ad_payouts")
    .insert({
      owner_id: user.id,
      slot_id: input.slotId,
      amount_cents: available,
      currency,
      address: slot.payout_address,
      status: "requested",
    })
    .select("id")
    .single();
  if (error || !payout) return { ok: false, error: error?.message ?? "Failed to record payout." };

  // Execute the on-chain transfer via CoinPay's payout API. On an explicit
  // rejection we mark the payout failed (which frees the balance to retry). On
  // a transient/config error we leave it 'requested' so it can be processed
  // later without double-paying.
  const result = await createCryptoPayout({
    recipientEmail: user.email ?? `${user.id}@users.crawlproof.com`,
    recipientWallet: slot.payout_address,
    amountUsd: available / 100,
    currency,
  });

  if (result.ok) {
    const settled = result.status === "completed";
    await supabase
      .from("ad_payouts")
      .update({
        status: settled ? "confirmed" : "sent",
        coinpay_payout_id: result.payoutId,
        tx_hash: result.txHash,
        settled_at: settled ? new Date().toISOString() : null,
      })
      .eq("id", payout.id);
    await supabase.from("ad_ledger").insert({
      kind: "publisher_payout",
      owner_id: user.id,
      slot_id: input.slotId,
      amount_cents: -available,
      currency,
      coinpay_payment_id: result.payoutId,
      tx_hash: result.txHash,
    });
    revalidatePath("/ads/slots");
    return { ok: true, amountCents: available };
  }

  if (!result.retryable) {
    await supabase.from("ad_payouts").update({ status: "failed" }).eq("id", payout.id);
    revalidatePath("/ads/slots");
    return { ok: false, error: result.error };
  }

  // Transient: keep the request queued (counts against the balance) and report.
  revalidatePath("/ads/slots");
  return { ok: true, amountCents: available };
}

// Upload an advertiser's own image (logo or hero) to the public ad-assets
// bucket; returns the public URL to store on a creative.
export async function uploadAdAsset(
  formData: FormData,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "No file provided." };
  if (file.size > MAX_ASSET_BYTES) return { ok: false, error: "Image must be under 2 MB." };
  const ct = file.type.toLowerCase();
  const ext = ct.includes("png")
    ? "png"
    : ct.includes("webp")
      ? "webp"
      : ct.includes("svg")
        ? "svg"
        : ct.includes("jpeg") || ct.includes("jpg")
          ? "jpg"
          : "";
  if (!ext) return { ok: false, error: "Use a PNG, JPG, WEBP, or SVG image." };

  const bytes = Buffer.from(await file.arrayBuffer());
  const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(ASSET_BUCKET).upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (error) return { ok: false, error: error.message };
  const { data } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);
  return { ok: true, url: data.publicUrl };
}
