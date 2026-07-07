"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAllowedTargetUrl } from "@/lib/rateLimit";
import { getOrCreateDefaultOrg } from "@/lib/orgs";
import {
  generateAdCreatives,
  AD_FORMAT_IDS,
  type AdCreative,
  type AdFormatId,
} from "@/lib/ads/creative";
import type { SiteBrand } from "@/lib/ads/brand";

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

  const org = await getOrCreateDefaultOrg({ userId: user.id, email: user.email });

  const payload: Record<string, unknown> = {
    owner_id: user.id,
    name: (input.name || domainOf(check.url)).slice(0, 120),
    destination_url: check.url,
    destination_domain: domainOf(check.url),
    daily_budget_cents: budget,
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

  // Confirm the project belongs to the user (RLS also enforces this).
  const { data: project } = await supabase
    .from("projects")
    .select("id, organization_id")
    .eq("id", input.projectId)
    .maybeSingle();
  if (!project) return { ok: false, error: "Project not found." };

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
