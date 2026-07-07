import crypto from "node:crypto";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import {
  AD_FORMAT_IDS,
  appendRef,
  renderCreativeHtml,
  type AdCreative,
  type AdFormatId,
} from "./creative";

// Server-side ad selection + metering. Runs under the service-role client so
// the public serving endpoints can read cross-tenant campaigns/creatives and
// append-write impressions/clicks. v1 is a flat, un-budgeted match: any active
// campaign with a ready creative in the requested format is eligible; we pick
// one at random to spread delivery. Auction + budget pacing are a later phase.

export type Fill = {
  impressionId: string;
  campaignId: string;
  creativeId: string;
  refSlug: string;
  creative: AdCreative;
  clickUrl: string;
  html: string;
};

export function isAdFormat(v: string | null | undefined): v is AdFormatId {
  return !!v && (AD_FORMAT_IDS as string[]).includes(v);
}

export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

type CreativeRow = {
  id: string;
  campaign_id: string;
  format: AdFormatId;
  headline: string;
  body: string;
  cta_text: string;
  image_url: string | null;
  logo_url: string | null;
  bg_color: string;
  fg_color: string;
  accent_color: string;
  font_family: string;
};

function rowToCreative(r: CreativeRow): AdCreative {
  return {
    format: r.format,
    headline: r.headline,
    body: r.body,
    ctaText: r.cta_text,
    bgColor: r.bg_color,
    fgColor: r.fg_color,
    accentColor: r.accent_color,
    fontFamily: r.font_family,
    logoUrl: r.logo_url,
    imageUrl: r.image_url,
  };
}

export type ServeContext = {
  visitorId?: string | null;
  ip?: string | null;
  country?: string | null;
  device?: string | null;
};

// Returns a rendered fill for the slot, or null if the slot is inactive /
// no eligible ad exists. Records the impression as a side effect.
export async function serveAd(
  slotId: string,
  format: AdFormatId,
  ctx: ServeContext = {},
): Promise<Fill | null> {
  const sb = serviceClient();

  const { data: slot } = await sb
    .from("ad_slots")
    .select("id, status, formats")
    .eq("id", slotId)
    .maybeSingle();
  if (!slot || slot.status !== "active") return null;
  if (Array.isArray(slot.formats) && !slot.formats.includes(format)) return null;

  // Active campaigns with a ready creative in this format. Join manually:
  // fetch candidate creatives whose campaign is active.
  const { data: creatives } = await sb
    .from("ad_creatives")
    .select(
      "id, campaign_id, format, headline, body, cta_text, image_url, logo_url, bg_color, fg_color, accent_color, font_family, ad_campaigns!inner(id, status, ref_slug, destination_url)",
    )
    .eq("format", format)
    .eq("status", "ready")
    .eq("ad_campaigns.status", "active")
    .limit(50);

  if (!creatives || creatives.length === 0) return null;

  const pick = creatives[Math.floor(Math.random() * creatives.length)] as unknown as CreativeRow & {
    ad_campaigns:
      | { id: string; ref_slug: string; destination_url: string }
      | { id: string; ref_slug: string; destination_url: string }[];
  };
  // Supabase embeds a to-one relation as an array under the permissive `any`
  // client; normalize to the single row.
  const campaign = Array.isArray(pick.ad_campaigns) ? pick.ad_campaigns[0] : pick.ad_campaigns;
  if (!campaign) return null;

  // Record the impression first so we have an id to bind the click to.
  const { data: imp } = await sb
    .from("ad_impressions")
    .insert({
      slot_id: slotId,
      campaign_id: campaign.id,
      creative_id: pick.id,
      visitor_id: ctx.visitorId ?? null,
      ip_hash: hashIp(ctx.ip ?? null),
      geo_country: ctx.country ?? null,
      device: ctx.device ?? null,
      billable: false,
    })
    .select("id")
    .single();

  const impressionId = imp?.id ?? crypto.randomUUID();
  const creative = rowToCreative(pick);

  // Click goes through our redirector so we can meter it, then lands on the
  // destination with ?ref= applied.
  const clickUrl = `${env.siteUrl}/api/ads/click?i=${impressionId}&s=${slotId}&c=${campaign.id}&cr=${pick.id}`;

  return {
    impressionId,
    campaignId: campaign.id,
    creativeId: pick.id,
    refSlug: campaign.ref_slug,
    creative,
    clickUrl,
    html: renderCreativeHtml(creative, clickUrl),
  };
}

// Resolve a click: record it, return the destination URL (with ?ref=) to
// redirect to. Returns null if the campaign/creative can't be resolved.
export async function resolveClick(input: {
  impressionId?: string | null;
  slotId?: string | null;
  campaignId?: string | null;
  creativeId?: string | null;
  ctx?: ServeContext;
}): Promise<string | null> {
  const sb = serviceClient();
  if (!input.campaignId) return null;

  const { data: campaign } = await sb
    .from("ad_campaigns")
    .select("id, destination_url, ref_slug, status")
    .eq("id", input.campaignId)
    .maybeSingle();
  if (!campaign) return null;

  await sb.from("ad_clicks").insert({
    impression_id: input.impressionId ?? null,
    slot_id: input.slotId ?? null,
    campaign_id: campaign.id,
    creative_id: input.creativeId ?? null,
    visitor_id: input.ctx?.visitorId ?? null,
    ip_hash: hashIp(input.ctx?.ip ?? null),
    geo_country: input.ctx?.country ?? null,
    device: input.ctx?.device ?? null,
    valid: true,
  });

  return appendRef(campaign.destination_url, campaign.ref_slug);
}
