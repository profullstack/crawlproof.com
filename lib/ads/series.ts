import type { SupabaseClient } from "@supabase/supabase-js";
import { bucketAxis, bucketOf, rangeSince, type RangeDef } from "./ranges";

export type AccountPoint = {
  /** Bucket start, epoch ms (epoch-aligned, matching SQL date_bin). */
  t: number;
  impressions: number;
  freeImpressions: number;
  clicks: number;
  freeClicks: number;
  spentCents: number;
};

export type RangeTotals = {
  impressions: number;
  freeImpressions: number;
  clicks: number;
  freeClicks: number;
  spentCents: number;
};

export const EMPTY_TOTALS: RangeTotals = {
  impressions: 0,
  freeImpressions: 0,
  clicks: 0,
  freeClicks: 0,
  spentCents: 0,
};

type AccountSeriesRow = {
  bucket: string;
  impressions: number | string;
  free_impressions: number | string;
  clicks: number | string;
  free_clicks: number | string;
  spent_cents: number | string;
};

/**
 * Account-wide bucketed series for a range, zero-filled across the whole window.
 *
 * Account-wide on purpose: a per-campaign version would return
 * (campaigns × buckets) rows and blow PostgREST's 1000-row cap on any wide
 * range — the same trap documented on getCampaignDailySeries below. Per-campaign
 * numbers for the same window come from getCampaignRangeTotals, which is
 * (campaigns) rows because it doesn't bucket.
 */
export async function getAccountSeries(
  supabase: SupabaseClient,
  range: RangeDef,
  now: Date = new Date(),
): Promise<AccountPoint[]> {
  const { data, error } = await supabase.rpc("ad_account_series", {
    p_since: rangeSince(range, now),
    p_bucket_seconds: range.bucketSeconds,
  });

  const rows = error ? [] : ((data as AccountSeriesRow[]) ?? []);

  // "All time" has no fixed start, so the axis runs from the oldest bucket that
  // actually has data rather than from a window offset.
  const axis =
    range.windowSeconds == null && rows.length > 0
      ? allTimeAxis(rows, range, now)
      : bucketAxis(range, now);

  const byBucket = new Map<number, AccountPoint>();
  for (const t of axis) {
    byBucket.set(t, {
      t,
      impressions: 0,
      freeImpressions: 0,
      clicks: 0,
      freeClicks: 0,
      spentCents: 0,
    });
  }

  for (const row of rows) {
    const point = byBucket.get(bucketOf(row.bucket, range));
    if (!point) continue;
    point.impressions += Number(row.impressions) || 0;
    point.freeImpressions += Number(row.free_impressions) || 0;
    point.clicks += Number(row.clicks) || 0;
    point.freeClicks += Number(row.free_clicks) || 0;
    point.spentCents += Number(row.spent_cents) || 0;
  }

  return [...byBucket.values()].sort((a, b) => a.t - b.t);
}

function allTimeAxis(rows: AccountSeriesRow[], range: RangeDef, now: Date): number[] {
  const stepMs = range.bucketSeconds * 1000;
  const first = Math.min(...rows.map((r) => bucketOf(r.bucket, range)));
  const last = Math.floor(now.getTime() / stepMs) * stepMs;
  const out: number[] = [];
  // Guard the loop: a clock skew that puts `first` after `last` would otherwise
  // spin forever building an axis that runs backwards.
  for (let t = Math.min(first, last); t <= last; t += stepMs) out.push(t);
  return out;
}

/** Sum a series into the headline figures for the range. */
export function sumSeries(points: AccountPoint[]): RangeTotals {
  return points.reduce<RangeTotals>(
    (a, p) => ({
      impressions: a.impressions + p.impressions,
      freeImpressions: a.freeImpressions + p.freeImpressions,
      clicks: a.clicks + p.clicks,
      freeClicks: a.freeClicks + p.freeClicks,
      spentCents: a.spentCents + p.spentCents,
    }),
    { ...EMPTY_TOTALS },
  );
}

/**
 * Everything actually shown in the range: paid inventory plus free backfill.
 *
 * The headline tiles report this rather than the paid figure alone. Paid-only
 * was fine while some delivery was paid, and read as a dead dashboard the
 * moment none of it was — a network whose slots and campaigns belong to the
 * same account books every fill as free tier (serveAd demotes a self-deal),
 * so every tile showed 0 while the chart underneath showed thousands of
 * impressions. A free-tier impression is still an impression; what it isn't is
 * revenue, and Spend is the tile that says so.
 */
export function deliveredImpressions(t: RangeTotals): number {
  return t.impressions + t.freeImpressions;
}

/** Clicks actually taken in the range: billed plus unbillable-but-real. */
export function deliveredClicks(t: RangeTotals): number {
  return t.clicks + t.freeClicks;
}

/**
 * Sub-line for a delivery tile: how its headline total divides into paid and
 * free. Silent when there is nothing to divide — a tile reading 0 needs no
 * footnote saying it was 0 paid and 0 free, and an all-paid tile is already
 * fully described by its own number.
 */
export function deliverySplitNote(paid: number, free: number): string | undefined {
  if (free === 0) return undefined;
  if (paid === 0) return "all free backfill";
  return `${paid.toLocaleString()} paid · ${free.toLocaleString()} free`;
}

/** Sparkline accessors, so a tile's shape plots the number above it. */
export const pickDeliveredImpressions = (p: AccountPoint): number =>
  p.impressions + p.freeImpressions;
export const pickDeliveredClicks = (p: AccountPoint): number => p.clicks + p.freeClicks;

type CampaignTotalsRow = {
  campaign_id: string;
  impressions: number | string;
  free_impressions: number | string;
  clicks: number | string;
  free_clicks: number | string;
  spent_cents: number | string;
};

/** Per-campaign totals for the same window, so the list agrees with the header. */
export async function getCampaignRangeTotals(
  supabase: SupabaseClient,
  range: RangeDef,
  now: Date = new Date(),
): Promise<Map<string, RangeTotals>> {
  const out = new Map<string, RangeTotals>();
  const { data, error } = await supabase.rpc("ad_campaign_totals", {
    p_since: rangeSince(range, now),
  });
  if (error) return out;

  for (const row of (data as CampaignTotalsRow[]) ?? []) {
    out.set(row.campaign_id, {
      impressions: Number(row.impressions) || 0,
      freeImpressions: Number(row.free_impressions) || 0,
      clicks: Number(row.clicks) || 0,
      freeClicks: Number(row.free_clicks) || 0,
      spentCents: Number(row.spent_cents) || 0,
    });
  }
  return out;
}

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
