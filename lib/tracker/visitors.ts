// Readers for the visitor rollup (tracker_visitor_daily_stats), the one place
// the tracker counts PEOPLE rather than beacons.
//
// WHY: the bucket rollup is bumped per event and stats.js fires several
// events per page view, so "Human visits" ran 100x above the number of
// people. Every headline now leads with distinct visitors from this rollup
// and shows the event count beside it under its real name.
//
// Every reader returns null when the RPC is missing or fails, and the pages
// render "unavailable" for that figure rather than 0: a zero here would be
// read as a dead site, which is the misreading the whole split exists to
// prevent. Rows begin on VISITORS_SINCE (there is no history to backfill:
// tracker_events keeps 24h), so a window that reaches further back is
// partial and the UI says so.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrackerKind } from "@/lib/tracker/humans";

type Sb = SupabaseClient<any, any, any>;

/** The UTC day the rollup migration was applied to production. */
export const VISITORS_SINCE = "2026-09-21";
export const VISITORS_SINCE_LABEL = "21 Sep 2026";
export const VISITORS_CAPTION = `Visitors counted from ${VISITORS_SINCE_LABEL}; earlier traffic has no visitor count.`;

export type VisitorTotals = {
  /** Distinct visitor ids in the window. */
  visitors: number;
  prevVisitors: number;
  /** Page views those visitors produced. */
  pageviews: number;
  prevPageviews: number;
};

export function emptyVisitorTotals(): VisitorTotals {
  return { visitors: 0, prevVisitors: 0, pageviews: 0, prevPageviews: 0 };
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** One row of tracker_visitor_totals; bigint columns arrive as strings. */
export type VisitorTotalsRow = {
  project_id: string;
  visitors: number | string;
  prev_visitors: number | string;
  pageviews: number | string;
  prev_pageviews: number | string;
};

export function toVisitorTotals(row: VisitorTotalsRow): VisitorTotals {
  return {
    visitors: num(row.visitors),
    prevVisitors: num(row.prev_visitors),
    pageviews: num(row.pageviews),
    prevPageviews: num(row.prev_pageviews),
  };
}

export function sumVisitorTotals(all: Iterable<VisitorTotals>): VisitorTotals {
  const out = emptyVisitorTotals();
  for (const t of all) {
    out.visitors += t.visitors;
    out.prevVisitors += t.prevVisitors;
    out.pageviews += t.pageviews;
    out.prevPageviews += t.prevPageviews;
  }
  return out;
}

/**
 * Distinct visitors per project over the last `days` UTC days and the equal
 * window before. Projects with no rows are absent from the map (0 visitors).
 * null when the RPC failed or does not exist yet.
 */
export async function fetchVisitorTotals(
  sb: Sb,
  projectIds: string[],
  days: number,
  kind: TrackerKind | null = "human",
): Promise<Map<string, VisitorTotals> | null> {
  const out = new Map<string, VisitorTotals>();
  if (projectIds.length === 0) return out;
  const { data, error } = await sb.rpc("tracker_visitor_totals", {
    p_projects: projectIds,
    days: Math.max(1, days),
    p_kind: kind,
  });
  if (error) return null;
  for (const row of (data ?? []) as VisitorTotalsRow[]) {
    out.set(row.project_id, toVisitorTotals(row));
  }
  return out;
}

export type VisitorDayRow = {
  project_id: string;
  day: string;
  visitors: number | string;
  pageviews: number | string;
};

/**
 * Visitors per (project, UTC day) over the last `days` days, as
 * project -> day -> visitors. Days with no rows are absent. null on failure.
 */
export async function fetchVisitorDailySeries(
  sb: Sb,
  projectIds: string[],
  days: number,
  kind: TrackerKind | null = "human",
): Promise<Map<string, Map<string, number>> | null> {
  const out = new Map<string, Map<string, number>>();
  for (const id of projectIds) out.set(id, new Map());
  if (projectIds.length === 0) return out;
  const { data, error } = await sb.rpc("tracker_visitor_daily_series", {
    p_projects: projectIds,
    days: Math.max(1, days),
    p_kind: kind,
  });
  if (error) return null;
  for (const row of (data ?? []) as VisitorDayRow[]) {
    out.get(row.project_id)?.set(row.day, num(row.visitors));
  }
  return out;
}

/**
 * Whether a window of `days` days ending today reaches back before the rollup
 * existed, in which case its visitor figure is partial and needs the caption.
 */
export function visitorsPartial(days: number, now = new Date()): boolean {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - Math.max(1, days) + 1);
  return start.toISOString().slice(0, 10) < VISITORS_SINCE;
}
