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
import { houseFill } from "./house";
import { CREDIT_CENTS, DEFAULT_BID_CREDITS, PLATFORM_RATE } from "./pricing";
import { assessClickValidity, isBotDevice } from "./fraud";
import { runAuction } from "./auction";

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

  // Bots get the house ad — never a paid impression (keeps advertiser stats
  // clean and avoids exposing paid creatives to crawlers).
  if (isBotDevice(ctx.device)) return houseFill(format);

  // Active campaigns with a ready creative in this format. Join manually:
  // fetch candidate creatives whose campaign is active.
  const { data: creatives } = await sb
    .from("ad_creatives")
    .select(
      "id, campaign_id, format, headline, body, cta_text, image_url, logo_url, bg_color, fg_color, accent_color, font_family, ad_campaigns!inner(id, status, ref_slug, destination_url, daily_budget_cents, spend_today_cents, spend_date, bid_credits)",
    )
    .eq("format", format)
    .eq("status", "ready")
    .eq("ad_campaigns.status", "active")
    .limit(100);

  // No paid creative for this format → default CrawlProof house ad.
  if (!creatives || creatives.length === 0) return houseFill(format);

  type CampaignJoin = {
    id: string;
    ref_slug: string;
    destination_url: string;
    daily_budget_cents: number;
    spend_today_cents: number;
    spend_date: string | null;
    bid_credits: number;
  };
  type Row = CreativeRow & { ad_campaigns: CampaignJoin | CampaignJoin[] };
  const oneCampaign = (c: CampaignJoin | CampaignJoin[]): CampaignJoin =>
    Array.isArray(c) ? c[0] : c;
  const today = new Date().toISOString().slice(0, 10); // UTC yyyy-mm-dd

  // Budget pacing: keep only campaigns with room for at least one more click at
  // their bid today. spend_today resets implicitly when spend_date is earlier.
  const eligible = (creatives as unknown as Row[]).filter((row) => {
    const c = oneCampaign(row.ad_campaigns);
    if (!c) return false;
    const spentToday = c.spend_date === today ? c.spend_today_cents : 0;
    const bid = c.bid_credits ?? DEFAULT_BID_CREDITS;
    return spentToday + bid * CREDIT_CENTS <= c.daily_budget_cents;
  });
  // Every candidate is out of budget → fall back to the house ad.
  if (eligible.length === 0) return houseFill(format);

  // First-price auction: highest bid wins (random tie-break). Live today.
  const auction = runAuction(
    eligible.map((row) => ({
      bidCredits: oneCampaign(row.ad_campaigns).bid_credits ?? DEFAULT_BID_CREDITS,
      item: row,
    })),
  );
  const pick = auction?.winner;
  if (!pick) return houseFill(format);
  const campaign = oneCampaign(pick.ad_campaigns);
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
    .select("id, destination_url, ref_slug, status, bid_credits")
    .eq("id", input.campaignId)
    .maybeSingle();
  if (!campaign) return null;

  // slot_id must be present (ad_clicks.slot_id NOT NULL) to record a click.
  if (input.slotId) {
    const ipHash = hashIp(input.ctx?.ip ?? null);
    const validity = await assessClickValidity({
      campaignId: campaign.id,
      slotId: input.slotId,
      impressionId: input.impressionId,
      visitorId: input.ctx?.visitorId,
      ipHash,
      device: input.ctx?.device,
    });

    if (validity.valid) {
      // Atomic charge: debit advertiser credits, meter the click, accrue the
      // publisher share + platform fee (unbilled if out of budget/funds).
      await sb.rpc("ad_charge_click", {
        p_campaign: campaign.id,
        p_slot: input.slotId,
        p_creative: input.creativeId ?? null,
        p_impression: input.impressionId ?? null,
        p_visitor: input.ctx?.visitorId ?? null,
        p_ip_hash: ipHash,
        p_country: input.ctx?.country ?? null,
        p_device: input.ctx?.device ?? null,
        // Charge the winning bid (first-price). Falls back to the default CPC.
        p_cpc_credits: campaign.bid_credits ?? DEFAULT_BID_CREDITS,
        p_platform_rate: PLATFORM_RATE,
      });
    } else {
      // Invalid (bot / duplicate / forged): record an unbilled click for
      // analytics, charge nobody.
      await sb.from("ad_clicks").insert({
        impression_id: input.impressionId ?? null,
        slot_id: input.slotId,
        campaign_id: campaign.id,
        creative_id: input.creativeId ?? null,
        visitor_id: input.ctx?.visitorId ?? null,
        ip_hash: ipHash,
        geo_country: input.ctx?.country ?? null,
        device: input.ctx?.device ?? null,
        charged_cents: 0,
        publisher_earn_cents: 0,
        platform_cut_cents: 0,
        valid: false,
      });
    }
  }

  // Always resolve the redirect, even if the click was unbilled.
  return appendRef(campaign.destination_url, campaign.ref_slug);
}
