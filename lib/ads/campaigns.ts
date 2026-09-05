// Campaigns created from outside the dashboard.
//
// The dashboard's saveCampaign (app/actions/ads.ts) takes creatives the person
// already previewed and edited. The API and the CLI have no preview step: a
// caller hands over a URL and expects a running campaign back, which is what
// myna does the moment it publishes a blog post. So this reads the page,
// writes the creatives, and saves — one call, service-role client, scoped by
// the owner id the bearer token resolved to.
//
// Idempotent on the destination: a second call for a URL that already has a
// live campaign returns that campaign rather than minting a twin. A blog post
// announced twice should not be paying for two campaigns.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCampaignRequest, parseCampaignPatch, isRefSlug, domainOf, type CampaignRequest, type CampaignStatus, type CampaignPatch } from "@/lib/ads/campaign-request";

export { parseCampaignRequest, parseCampaignPatch, isRefSlug, domainOf, type CampaignRequest, type CampaignStatus, type CampaignPatch };
import { getOrCreateDefaultOrg } from "@/lib/orgs";
import { generateAdCreatives, cleanSummary, creativesFromCopy, templateCopy, summaryDomain, type AdCreative, type AdSummary } from "@/lib/ads/creative";
import { extractSiteBrand, type SiteBrand } from "@/lib/ads/brand";
import { DEFAULT_BID_CREDITS } from "@/lib/ads/pricing";

export type CampaignSummary = {
  id: string;
  ref_slug: string;
  name: string;
  status: string;
  destination_url: string;
  daily_budget_cents: number;
  bid_credits: number | null;
  created_at?: string;
  creatives?: number;
  dashboard_url?: string;
  /** True when a live campaign for this URL already existed and was returned instead. */
  existing?: boolean;
};

export type CampaignResult =
  | { ok: true; campaign: CampaignSummary }
  | { ok: false; status: number; error: string };

/** Statuses under which a second campaign for the same URL would be a twin. */
const LIVE_STATUSES = ["active", "draft", "paused", "pending_review"];

function creativeRow(campaignId: string, ownerId: string, c: AdCreative) {
  return {
    campaign_id: campaignId,
    owner_id: ownerId,
    format: c.format,
    headline: (c.headline ?? "").slice(0, 80),
    body: (c.body ?? "").slice(0, 140),
    cta_text: (c.ctaText ?? "Learn more").slice(0, 24) || "Learn more",
    image_url: c.imageUrl ?? null,
    logo_url: c.logoUrl ?? null,
    bg_color: c.bgColor,
    fg_color: c.fgColor,
    accent_color: c.accentColor,
    light_bg_color: c.lightBgColor ?? null,
    light_fg_color: c.lightFgColor ?? null,
    light_accent_color: c.lightAccentColor ?? null,
    font_family: (c.fontFamily ?? "system-ui, sans-serif").slice(0, 200),
  };
}

function summaryColumns(summary: AdSummary | null | undefined, domain: string): Record<string, unknown> {
  if (!summary) return {};
  const short = cleanSummary(summary.short, 400);
  const long = cleanSummary(summary.long, 1600);
  if (!short && !long) return {};
  if (String(summary.domain ?? "").toLowerCase() !== domain.toLowerCase()) return {};
  return {
    summary_short: short || null,
    summary_long: long || null,
    summary_domain: domain.toLowerCase(),
    summary_generated_at: new Date().toISOString(),
  };
}

const schemaLag = (message: string | undefined) => /organization_id|summary_|schema cache|column/i.test(message ?? "");

export async function createCampaignForUrl(input: {
  sb: SupabaseClient;
  userId: string;
  email?: string | null;
  request: CampaignRequest;
  siteUrl: string;
}): Promise<CampaignResult> {
  const { sb, userId, request } = input;
  const status: CampaignStatus = request.status ?? "active";
  const domain = domainOf(request.url);

  // A live twin wins over a new campaign. If the caller wants it running and
  // it is only a draft, running it is what they asked for.
  const { data: twin } = await sb
    .from("ad_campaigns")
    .select("id, ref_slug, name, status, destination_url, daily_budget_cents, bid_credits, created_at")
    .eq("owner_id", userId)
    .eq("destination_url", request.url)
    .in("status", LIVE_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (twin) {
    let current = twin.status as string;
    if (status === "active" && current !== "active") {
      const { error } = await sb.from("ad_campaigns").update({ status: "active" }).eq("id", twin.id).eq("owner_id", userId);
      if (!error) current = "active";
    }
    return {
      ok: true,
      campaign: {
        ...(twin as CampaignSummary),
        status: current,
        existing: true,
        dashboard_url: `${input.siteUrl}/dashboard/ads/${twin.id}`,
      },
    };
  }

  let generated: { brand: SiteBrand; creatives: AdCreative[]; summary: AdSummary | null; provider: string };
  try {
    generated = await generateAdCreatives(request.url, { supabase: sb });
  } catch (err) {
    // No model with credit, or one that failed: the page's own words are the
    // copy. A campaign that could not open would mean a post with no ad.
    try {
      const brand = await extractSiteBrand(request.url);
      const copy = templateCopy(brand);
      generated = {
        brand,
        creatives: creativesFromCopy(brand, copy, brand.ogImage),
        summary: copy.summaryShort ? { short: cleanSummary(copy.summaryShort, 400), long: "", domain: summaryDomain(brand.url || request.url) } : null,
        provider: `template (${err instanceof Error ? err.message.slice(0, 80) : "generator failed"})`,
      };
    } catch (inner) {
      return { ok: false, status: 502, error: inner instanceof Error ? `Could not read that URL: ${inner.message}` : "Could not read that URL." };
    }
  }
  if (!generated.creatives.length) return { ok: false, status: 502, error: "No creatives could be written for that URL." };

  const org = await getOrCreateDefaultOrg({ userId, email: input.email }).catch(() => ({ id: null as string | null }));
  const payload: Record<string, unknown> = {
    owner_id: userId,
    name: (request.name || generated.brand.title?.slice(0, 60) || domain).slice(0, 120),
    destination_url: request.url,
    destination_domain: domain,
    daily_budget_cents: request.dailyBudgetCents ?? 500,
    bid_credits: request.bidCredits ?? DEFAULT_BID_CREDITS,
    status,
    brand: generated.brand ?? {},
    ...summaryColumns(generated.summary, domain),
  };
  if (org.id) payload.organization_id = org.id;

  const select = "id, ref_slug, name, status, destination_url, daily_budget_cents, bid_credits, created_at";
  let inserted = await sb.from("ad_campaigns").insert(payload).select(select).single();
  // Migrations here are applied by hand, so a deploy can run ahead of the
  // schema; the optional columns are dropped rather than refusing the campaign.
  if (inserted.error && schemaLag(inserted.error.message)) {
    for (const key of Object.keys(payload)) if (key === "organization_id" || key.startsWith("summary_")) delete payload[key];
    inserted = await sb.from("ad_campaigns").insert(payload).select(select).single();
  }
  if (inserted.error || !inserted.data) {
    return { ok: false, status: 500, error: inserted.error?.message ?? "Failed to save the campaign." };
  }
  const campaign = inserted.data as CampaignSummary;

  const { error: creativeError } = await sb
    .from("ad_creatives")
    .insert(generated.creatives.map((c) => creativeRow(campaign.id, userId, c)));
  if (creativeError) {
    // A campaign with no creatives serves nothing; do not leave it behind.
    await sb.from("ad_campaigns").delete().eq("id", campaign.id).eq("owner_id", userId);
    return { ok: false, status: 500, error: creativeError.message };
  }

  return {
    ok: true,
    campaign: {
      ...campaign,
      creatives: generated.creatives.length,
      dashboard_url: `${input.siteUrl}/dashboard/ads/${campaign.id}`,
    },
  };
}

export async function listCampaigns(input: { sb: SupabaseClient; userId: string; limit: number; siteUrl: string }): Promise<CampaignSummary[]> {
  const { data } = await input.sb
    .from("ad_campaigns")
    .select("id, ref_slug, name, status, destination_url, daily_budget_cents, bid_credits, created_at")
    .eq("owner_id", input.userId)
    .order("created_at", { ascending: false })
    .limit(Math.min(200, Math.max(1, input.limit)));
  return ((data as CampaignSummary[]) ?? []).map((c) => ({ ...c, dashboard_url: `${input.siteUrl}/dashboard/ads/${c.id}` }));
}

// ------------------------------------------------------------ one campaign

const CAMPAIGN_COLUMNS = "id, ref_slug, name, status, destination_url, daily_budget_cents, bid_credits, created_at";

/** The caller's campaign by id or ref slug, or null. */
export async function findCampaign(sb: SupabaseClient, userId: string, idOrRef: string): Promise<CampaignSummary | null> {
  const key = idOrRef.trim();
  let query = sb.from("ad_campaigns").select(CAMPAIGN_COLUMNS).eq("owner_id", userId);
  query = isRefSlug(key) ? query.eq("ref_slug", key.toLowerCase()) : query.eq("id", key);
  const { data } = await query.maybeSingle();
  return (data as CampaignSummary | null) ?? null;
}

export type CampaignStats = {
  impressions: number;
  clicks: number;
  spent_cents: number;
  spend_today_cents: number;
  free_impressions: number;
  free_clicks: number;
  /** Visits the tracker attributed to this campaign on the caller's own sites, by day. */
  visits: { total: number; days: { day: string; visits: number }[] };
};

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Delivery from the stats view, plus ad:<ref> visits on the caller's tracked sites. */
export async function campaignStats(sb: SupabaseClient, userId: string, campaign: CampaignSummary): Promise<CampaignStats> {
  const { data: row } = await sb.from("ad_campaign_stats").select("*").eq("campaign_id", campaign.id).maybeSingle();
  const r = (row as Record<string, unknown> | null) ?? {};

  const { data: projects } = await sb.from("projects").select("id").eq("owner_id", userId);
  const ids = ((projects as { id: string }[]) ?? []).map((p) => p.id);
  const days: { day: string; visits: number }[] = [];
  if (ids.length) {
    const { data: rows } = await sb
      .from("tracker_daily_stats")
      .select("day, count")
      .in("project_id", ids)
      .eq("bucket", `ad:${campaign.ref_slug}`)
      .order("day", { ascending: false })
      .limit(60);
    const byDay = new Map<string, number>();
    for (const item of (rows as { day: string; count: number }[]) ?? []) byDay.set(item.day, (byDay.get(item.day) ?? 0) + n(item.count));
    for (const [day, visits] of byDay) days.push({ day, visits });
  }
  return {
    impressions: n(r.impressions),
    clicks: n(r.clicks),
    spent_cents: n(r.spent_cents),
    spend_today_cents: n(r.spend_today_cents),
    free_impressions: n(r.free_impressions),
    free_clicks: n(r.free_clicks),
    visits: { total: days.reduce((sum, d) => sum + d.visits, 0), days },
  };
}

export async function patchCampaign(
  sb: SupabaseClient,
  userId: string,
  campaign: CampaignSummary,
  patch: CampaignPatch,
): Promise<{ ok: true; campaign: CampaignSummary } | { ok: false; status: number; error: string }> {
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.dailyBudgetCents !== undefined) update.daily_budget_cents = patch.dailyBudgetCents;
  if (patch.bidCredits !== undefined) update.bid_credits = patch.bidCredits;
  if (patch.status !== undefined) {
    if (patch.status === "active") {
      // The dashboard's rule: nothing goes live without a creative to show.
      const { count } = await sb.from("ad_creatives").select("id", { count: "exact", head: true }).eq("campaign_id", campaign.id).eq("status", "ready");
      if (!count) return { ok: false, status: 409, error: "This campaign has no ready creative; add one in the dashboard before activating." };
    }
    update.status = patch.status;
  }
  const { data, error } = await sb.from("ad_campaigns").update(update).eq("id", campaign.id).eq("owner_id", userId).select(CAMPAIGN_COLUMNS).single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "Failed to update the campaign." };
  return { ok: true, campaign: data as CampaignSummary };
}

/** Delete outright. Impressions and clicks cascade with it; pausing keeps them. */
export async function deleteCampaign(sb: SupabaseClient, userId: string, campaign: CampaignSummary): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { error } = await sb.from("ad_campaigns").delete().eq("id", campaign.id).eq("owner_id", userId);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true };
}
