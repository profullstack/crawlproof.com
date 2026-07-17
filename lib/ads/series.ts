import type { SupabaseClient } from "@supabase/supabase-js";

export type CampaignDailyPoint = {
  /** UTC calendar day, YYYY-MM-DD */
  date: string;
  impressions: number;
  clicks: number;
  spentCents: number;
};

export type SlotDailyPoint = {
  /** UTC calendar day, YYYY-MM-DD */
  date: string;
  clicks: number;
  earnedCents: number;
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Build a zero-filled list of the last `days` UTC calendar days, oldest first. */
function dayAxis(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

type DailySeriesRow = {
  campaign_id: string;
  day: string; // YYYY-MM-DD (UTC)
  impressions: number | string;
  clicks: number | string;
  spent_cents: number | string;
};

/**
 * Per-campaign daily impressions / clicks / spend for the last `days`.
 *
 * Aggregated server-side by the ad_campaign_daily_series RPC (security_invoker,
 * so RLS scopes it to the caller's own campaigns). We must NOT fetch and bucket
 * raw ad_impressions rows here: PostgREST caps a response at 1000 rows, so once
 * total impressions in the window exceed 1000 a few high-volume campaigns eat
 * the whole page and every other campaign gets zero rows back — rendering
 * "no traffic yet" despite having recent impressions. The RPC returns at most
 * (campaigns * days) rows, so it never hits the cap.
 * See migration 20260717032002_ad_campaign_daily_series_rpc.sql.
 */
export async function getCampaignDailySeries(
  supabase: SupabaseClient,
  campaignIds: string[],
  days = 30,
): Promise<Map<string, CampaignDailyPoint[]>> {
  const axis = dayAxis(days);
  const result = new Map<string, CampaignDailyPoint[]>();
  const emptyFor = () =>
    axis.map((date) => ({ date, impressions: 0, clicks: 0, spentCents: 0 }));
  for (const id of campaignIds) result.set(id, emptyFor());
  if (campaignIds.length === 0) return result;

  // index[campaignId][date] -> point, for O(1) accumulation
  const index = new Map<string, Map<string, CampaignDailyPoint>>();
  for (const id of campaignIds) {
    const byDay = new Map<string, CampaignDailyPoint>();
    for (const p of result.get(id)!) byDay.set(p.date, p);
    index.set(id, byDay);
  }

  const { data, error } = await supabase.rpc("ad_campaign_daily_series", {
    days,
  });
  // On error, fall back to the zero-filled series rather than throwing the page.
  if (error) return result;

  for (const row of (data as DailySeriesRow[]) ?? []) {
    const point = index.get(row.campaign_id)?.get(dayKey(row.day));
    if (point) {
      point.impressions += Number(row.impressions) || 0;
      point.clicks += Number(row.clicks) || 0;
      point.spentCents += Number(row.spent_cents) || 0;
    }
  }

  return result;
}

type SlotSeriesRow = {
  slot_id: string;
  day: string; // YYYY-MM-DD (UTC)
  clicks: number | string;
  earned_cents: number | string;
};

/**
 * Per-slot daily clicks / publisher earnings for the last `days`.
 * Server-side aggregate via the ad_slot_daily_series RPC (security_invoker →
 * RLS scopes to the caller's own slots). Same 1000-row-cap rationale as
 * getCampaignDailySeries. See migration 20260717150000_ad_slot_daily_series_rpc.sql.
 */
export async function getSlotDailySeries(
  supabase: SupabaseClient,
  slotIds: string[],
  days = 30,
): Promise<Map<string, SlotDailyPoint[]>> {
  const axis = dayAxis(days);
  const result = new Map<string, SlotDailyPoint[]>();
  const emptyFor = () => axis.map((date) => ({ date, clicks: 0, earnedCents: 0 }));
  for (const id of slotIds) result.set(id, emptyFor());
  if (slotIds.length === 0) return result;

  const index = new Map<string, Map<string, SlotDailyPoint>>();
  for (const id of slotIds) {
    const byDay = new Map<string, SlotDailyPoint>();
    for (const p of result.get(id)!) byDay.set(p.date, p);
    index.set(id, byDay);
  }

  const { data, error } = await supabase.rpc("ad_slot_daily_series", { days });
  if (error) return result;

  for (const row of (data as SlotSeriesRow[]) ?? []) {
    const point = index.get(row.slot_id)?.get(dayKey(row.day));
    if (point) {
      point.clicks += Number(row.clicks) || 0;
      point.earnedCents += Number(row.earned_cents) || 0;
    }
  }

  return result;
}

/** Merge campaign spend series + slot earnings series into one account-wide
 * daily spend/earn axis (zero-filled, oldest first). */
export function mergeMoneySeries(
  campaign: Map<string, CampaignDailyPoint[]>,
  slot: Map<string, SlotDailyPoint[]>,
  days = 30,
): { date: string; spentCents: number; earnedCents: number }[] {
  const byDate = new Map<string, { date: string; spentCents: number; earnedCents: number }>();
  for (const date of dayAxis(days)) byDate.set(date, { date, spentCents: 0, earnedCents: 0 });
  for (const points of campaign.values())
    for (const p of points) {
      const d = byDate.get(p.date);
      if (d) d.spentCents += p.spentCents;
    }
  for (const points of slot.values())
    for (const p of points) {
      const d = byDate.get(p.date);
      if (d) d.earnedCents += p.earnedCents;
    }
  return [...byDate.values()];
}
