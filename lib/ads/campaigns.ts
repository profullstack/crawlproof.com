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
import { parseCampaignRequest, domainOf, type CampaignRequest, type CampaignStatus } from "@/lib/ads/campaign-request";

export { parseCampaignRequest, domainOf, type CampaignRequest, type CampaignStatus };
import { getOrCreateDefaultOrg } from "@/lib/orgs";
import { generateAdCreatives, cleanSummary, type AdCreative, type AdSummary } from "@/lib/ads/creative";
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

  let generated: Awaited<ReturnType<typeof generateAdCreatives>>;
  try {
    generated = await generateAdCreatives(request.url, { supabase: sb });
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? `Could not write ads for that URL: ${err.message}` : "Could not write ads for that URL." };
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
