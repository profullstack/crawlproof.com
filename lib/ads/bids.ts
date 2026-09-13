// Bids as rows: the autobid sweep, the bid history a campaign page plots, and
// the paper charge a free-tier click records.
//
// The controller itself is lib/ads/autobid.ts and is pure. This module is the
// part that touches the database, and it is written against a SupabaseClient
// so the worker (service role) and the server actions can both call it.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decideBid,
  medianBid,
  paperSpendTodayCents,
  utcDayFraction,
  type AutobidDecision,
} from "./autobid";
import { CREDIT_CENTS, DEFAULT_BID_CREDITS } from "./pricing";
import { spendTodayCents, utcToday } from "./status";

// ------------------------------------------------------------------ sweep

/** A bid held this long without a decision gets one anyway, so history has a point per day. */
export const AUTOBID_HEARTBEAT_MS = 24 * 60 * 60 * 1000;
/** Delivery window the controller reads: the last day. */
export const AUTOBID_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

type SweepCampaign = {
  id: string;
  owner_id: string;
  status: string;
  autobid: boolean | null;
  bid_credits: number | null;
  daily_budget_cents: number;
  spend_today_cents: number | null;
  spend_date: string | null;
  paper_spend_today_cents: number | null;
  paper_spend_date: string | null;
  bid_updated_at: string | null;
};

type BidRow = {
  campaign_id: string;
  owner_id: string;
  ts: string;
  bid_credits: number;
  prev_bid_credits: number | null;
  source: "auto" | "manual" | "seed";
  reason: string;
  signals: Record<string, unknown>;
};

export type AutobidSweepResult = {
  considered: number;
  changed: number;
  seeded: number;
  held: number;
  /** The read that failed, when one did. Nothing was written. */
  failed?: string;
};

const num = (v: unknown, fallback = 0): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};

/**
 * Recompute the bid of every live autobid campaign, once.
 *
 * Reads the campaigns, the formats each can fill (its ready creatives), and
 * a day of delivery per campaign, then runs decideBid over each. A changed bid
 * is written back to the campaign and to ad_bids with the signals that moved
 * it; an unchanged one is logged only when nothing has been logged for a day,
 * so a flat chart still has a point per day and the table stays small.
 *
 * Competition is per format: a campaign's competitors are every other live
 * campaign with a ready creative in any format this one has. The market bid
 * is the median across them. On a network where nobody has a third-party
 * advertiser this is the whole point — the campaigns bid against each other.
 */
export async function runAutobidSweep(
  sb: SupabaseClient,
  now: Date = new Date(),
): Promise<AutobidSweepResult> {
  const result: AutobidSweepResult = { considered: 0, changed: 0, seeded: 0, held: 0 };

  const { data: campaignRows, error: campaignError } = await sb
    .from("ad_campaigns")
    .select(
      "id, owner_id, status, autobid, bid_credits, daily_budget_cents, spend_today_cents, spend_date, paper_spend_today_cents, paper_spend_date, bid_updated_at",
    )
    .in("status", ["active", "exhausted"])
    .eq("autobid", true)
    .limit(1000);
  if (campaignError) return { ...result, failed: `ad_campaigns: ${campaignError.message}` };
  const campaigns = (campaignRows as SweepCampaign[] | null) ?? [];
  if (!campaigns.length) return result;
  const ids = campaigns.map((c) => c.id);

  const { data: creativeRows, error: creativeError } = await sb
    .from("ad_creatives")
    .select("campaign_id, format")
    .eq("status", "ready")
    .in("campaign_id", ids)
    .range(0, 4999);
  if (creativeError) return { ...result, failed: `ad_creatives: ${creativeError.message}` };

  const since = new Date(now.getTime() - AUTOBID_ACTIVITY_WINDOW_MS).toISOString();
  const { data: activityRows, error: activityError } = await sb.rpc("ad_autobid_activity", {
    p_since: since,
  });
  if (activityError) return { ...result, failed: `ad_autobid_activity: ${activityError.message}` };

  // Who competes with whom: campaigns by format, then the union per campaign.
  const formatsByCampaign = new Map<string, Set<string>>();
  const campaignsByFormat = new Map<string, Set<string>>();
  for (const row of (creativeRows as { campaign_id: string; format: string }[] | null) ?? []) {
    if (!formatsByCampaign.has(row.campaign_id)) formatsByCampaign.set(row.campaign_id, new Set());
    formatsByCampaign.get(row.campaign_id)!.add(row.format);
    if (!campaignsByFormat.has(row.format)) campaignsByFormat.set(row.format, new Set());
    campaignsByFormat.get(row.format)!.add(row.campaign_id);
  }
  const bidOf = new Map(campaigns.map((c) => [c.id, c.bid_credits ?? DEFAULT_BID_CREDITS]));

  const activity = new Map<string, { impressions: number; clicks: number }>();
  for (const row of (activityRows as { campaign_id: string; impressions: unknown; clicks: unknown }[] | null) ?? []) {
    activity.set(row.campaign_id, { impressions: num(row.impressions), clicks: num(row.clicks) });
  }

  const today = utcToday(now);
  const dayFraction = utcDayFraction(now);
  const nowIso = now.toISOString();
  // A seed row is stamped a second earlier than the decision that follows it,
  // so "newest first" reads seed → first decision in the right order.
  const seedIso = new Date(now.getTime() - 1000).toISOString();
  const heartbeatBefore = now.getTime() - AUTOBID_HEARTBEAT_MS;

  const inserts: BidRow[] = [];
  const updates: { id: string; bid_credits: number }[] = [];
  const touches: string[] = [];

  for (const c of campaigns) {
    result.considered += 1;
    const current = c.bid_credits ?? DEFAULT_BID_CREDITS;

    const rivals = new Set<string>();
    for (const format of formatsByCampaign.get(c.id) ?? []) {
      for (const id of campaignsByFormat.get(format) ?? []) rivals.add(id);
    }
    rivals.add(c.id);
    const market = medianBid([...rivals].map((id) => bidOf.get(id) ?? DEFAULT_BID_CREDITS));
    const seen = activity.get(c.id) ?? { impressions: 0, clicks: 0 };

    const decision: AutobidDecision = decideBid({
      bidCredits: current,
      dailyBudgetCents: num(c.daily_budget_cents),
      spentTodayCents: spendTodayCents(c, today) + paperSpendTodayCents(c, today),
      dayFraction,
      impressions24h: seen.impressions,
      clicks24h: seen.clicks,
      competitors: rivals.size,
      marketBidCredits: market,
    });

    const neverLogged = !c.bid_updated_at;
    if (neverLogged) {
      result.seeded += 1;
      inserts.push({
        campaign_id: c.id,
        owner_id: c.owner_id,
        ts: seedIso,
        bid_credits: current,
        prev_bid_credits: null,
        source: "seed",
        reason: "seed",
        signals: {},
      });
    }

    const stale = !neverLogged && Date.parse(c.bid_updated_at!) < heartbeatBefore;
    if (decision.changed) {
      result.changed += 1;
      updates.push({ id: c.id, bid_credits: decision.bidCredits });
    } else {
      result.held += 1;
      if (neverLogged || stale) touches.push(c.id);
    }
    if (decision.changed || neverLogged || stale) {
      inserts.push({
        campaign_id: c.id,
        owner_id: c.owner_id,
        ts: nowIso,
        bid_credits: decision.bidCredits,
        prev_bid_credits: current,
        source: "auto",
        reason: decision.reason,
        signals: decision.signals,
      });
    }
  }

  for (const u of updates) {
    const { error } = await sb
      .from("ad_campaigns")
      .update({ bid_credits: u.bid_credits, bid_updated_at: nowIso })
      .eq("id", u.id);
    if (error) return { ...result, failed: `ad_campaigns update: ${error.message}` };
  }
  if (touches.length) {
    const { error } = await sb
      .from("ad_campaigns")
      .update({ bid_updated_at: nowIso })
      .in("id", touches);
    if (error) return { ...result, failed: `ad_campaigns touch: ${error.message}` };
  }
  if (inserts.length) {
    const { error } = await sb.from("ad_bids").insert(inserts);
    if (error) return { ...result, failed: `ad_bids insert: ${error.message}` };
  }
  return result;
}

// ---------------------------------------------------------- manual bids

/**
 * Log a bid somebody typed. Called after the campaign row is already updated
 * under the caller's own ownership check; the service role writes the log.
 */
export async function recordManualBid(
  sb: SupabaseClient,
  input: { campaignId: string; ownerId: string; prevBidCredits: number | null; bidCredits: number; reason?: string },
): Promise<void> {
  if (input.prevBidCredits === input.bidCredits) return;
  try {
    await sb.from("ad_bids").insert({
      campaign_id: input.campaignId,
      owner_id: input.ownerId,
      bid_credits: input.bidCredits,
      prev_bid_credits: input.prevBidCredits,
      source: "manual",
      reason: input.reason ?? "manual",
      signals: {},
    });
    await sb.from("ad_campaigns").update({ bid_updated_at: new Date().toISOString() }).eq("id", input.campaignId);
  } catch {
    // The log rides behind a hand-applied migration; a missing table must not
    // fail the edit that was already made.
  }
}

// ---------------------------------------------------------- paper charge

/**
 * Record what a free-tier click would have cost. Never moves money: the SQL
 * refuses any click that billed, and a failure here (table not there yet,
 * network) costs the paper ledger one row and nobody anything.
 */
export async function paperCharge(
  sb: SupabaseClient,
  input: { clickId: string | null | undefined; campaignId: string; bidCredits: number | null | undefined },
): Promise<void> {
  if (!input.clickId) return;
  const cents = (input.bidCredits ?? DEFAULT_BID_CREDITS) * CREDIT_CENTS;
  try {
    await sb.rpc("ad_paper_charge", { p_click: input.clickId, p_campaign: input.campaignId, p_cents: cents });
  } catch {
    // see above
  }
}

// ----------------------------------------------------------- bid history

export type BidHistoryDay = {
  /** UTC calendar day, YYYY-MM-DD */
  date: string;
  impressions: number;
  /** Real clicks on both tiers: billed plus free. */
  clicks: number;
  /** Visits the tracker attributed to this campaign on the owner's sites. */
  visits: number;
  /** What the day's free-tier clicks would have cost. */
  paperCents: number;
  /** What the day's billed clicks did cost. */
  spentCents: number;
  /** The bid in force at the end of the day, carried across quiet days. */
  bidCredits: number | null;
  /** Mean bid on the fills it won that day, when any recorded one. */
  wonBidCredits: number | null;
};

export type BidEvent = {
  ts: string;
  bidCredits: number;
  prevBidCredits: number | null;
  source: "auto" | "manual" | "seed";
  reason: string;
  signals: Record<string, unknown>;
};

export type BidHistory = {
  days: BidHistoryDay[];
  /** Newest first. */
  events: BidEvent[];
  failed: boolean;
};

type HistoryDayRow = {
  day: string;
  impressions: unknown;
  won_bid: unknown;
  clicks: unknown;
  paper_cents: unknown;
  spent_cents: unknown;
  bid: unknown;
};

type HistoryEventRow = {
  ts: string;
  bid_credits: unknown;
  prev_bid_credits: unknown;
  source: string;
  reason: string;
  signals: unknown;
};

/** Zero-filled list of the last `days` UTC calendar days, oldest first. */
function dayAxis(days: number, now: Date): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Fold the RPC's per-day rows onto a day axis, carrying the bid forward.
 *
 * A bid is recorded when it changes (and once a day otherwise), so most days
 * have no row of their own; the bid in force on such a day is the last one
 * recorded before it. Days before the first record take the first record's
 * value — the campaign had that bid before anybody wrote it down — and a
 * campaign with no record at all takes its current bid throughout. Pure, so
 * the carry rules are testable.
 */
export function foldBidHistory(input: {
  axis: string[];
  days: HistoryDayRow[];
  visitsByDay: Map<string, number>;
  bidBefore: number | null;
  currentBid: number;
}): BidHistoryDay[] {
  const byDay = new Map(input.days.map((r) => [String(r.day).slice(0, 10), r]));
  let running: number | null = input.bidBefore;
  const out: BidHistoryDay[] = [];
  for (const date of input.axis) {
    const row = byDay.get(date);
    const bid = row && row.bid != null ? num(row.bid) : null;
    if (bid != null) running = bid;
    out.push({
      date,
      impressions: num(row?.impressions),
      clicks: num(row?.clicks),
      visits: input.visitsByDay.get(date) ?? 0,
      paperCents: num(row?.paper_cents),
      spentCents: num(row?.spent_cents),
      bidCredits: running,
      wonBidCredits: row && row.won_bid != null ? num(row.won_bid) : null,
    });
  }
  const first = out.find((d) => d.bidCredits != null)?.bidCredits ?? input.currentBid;
  for (const d of out) {
    if (d.bidCredits == null) d.bidCredits = first;
    else break;
  }
  return out;
}

/**
 * Bid vs delivery for one campaign over the last `days`, plus the decision log.
 *
 * The delivery half comes from ad_campaign_bid_history (one jsonb document,
 * so the PostgREST row cap cannot truncate it). Visits come from the tracker's
 * daily rollup under the `ad:<ref>` bucket across the owner's projects — the
 * same attribution the API's campaignStats reports — and only exist where the
 * destination runs the tracker. A missing RPC reads as failed with a flat,
 * zero-filled axis rather than throwing the page.
 */
export async function getBidHistory(
  sb: SupabaseClient,
  input: { campaignId: string; refSlug: string; ownerId: string; currentBid: number | null; days?: number },
  now: Date = new Date(),
): Promise<BidHistory> {
  const days = Math.max(1, Math.floor(input.days ?? 30));
  const axis = dayAxis(days, now);
  const currentBid = input.currentBid ?? DEFAULT_BID_CREDITS;

  const visitsByDay = new Map<string, number>();
  try {
    const { data: projects } = await sb.from("projects").select("id").eq("owner_id", input.ownerId);
    const ids = ((projects as { id: string }[] | null) ?? []).map((p) => p.id);
    if (ids.length) {
      const { data: rows } = await sb
        .from("tracker_daily_stats")
        .select("day, count")
        .in("project_id", ids)
        .eq("bucket", `ad:${input.refSlug}`)
        .gte("day", axis[0])
        .limit(1000);
      for (const r of (rows as { day: string; count: unknown }[] | null) ?? []) {
        const key = String(r.day).slice(0, 10);
        visitsByDay.set(key, (visitsByDay.get(key) ?? 0) + num(r.count));
      }
    }
  } catch {
    // No tracker data is an empty series, not a failed page.
  }

  type HistoryPayload = { days?: HistoryDayRow[]; bids?: HistoryEventRow[]; bid_before?: unknown };
  let payload: HistoryPayload | null = null;
  let failed = false;
  try {
    const { data, error } = await sb.rpc("ad_campaign_bid_history", {
      p_campaign: input.campaignId,
      p_days: days,
    });
    if (error) failed = true;
    else payload = (data as HistoryPayload | null) ?? null;
  } catch {
    failed = true;
  }

  const daysOut = foldBidHistory({
    axis,
    days: payload?.days ?? [],
    visitsByDay,
    bidBefore: payload?.bid_before == null ? null : num(payload.bid_before),
    currentBid,
  });
  const events: BidEvent[] = (payload?.bids ?? []).map((b) => ({
    ts: b.ts,
    bidCredits: num(b.bid_credits),
    prevBidCredits: b.prev_bid_credits == null ? null : num(b.prev_bid_credits),
    source: (["auto", "manual", "seed"].includes(b.source) ? b.source : "auto") as BidEvent["source"],
    reason: String(b.reason ?? ""),
    signals: (b.signals && typeof b.signals === "object" ? b.signals : {}) as Record<string, unknown>,
  }));

  return { days: daysOut, events, failed };
}
