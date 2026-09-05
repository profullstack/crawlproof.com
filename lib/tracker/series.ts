// Shared shaping for the tracker_daily_series / tracker_daily_series_multi
// RPCs. Both the per-project stats page and the portfolio analytics page map
// the sparse per-day rows onto a zero-filled UTC axis so gaps render as flat
// spans rather than being skipped entirely.

import { humansFrom } from "@/lib/tracker/humans";

export type TrackerSeriesRow = {
  day: string;
  pageviews: number;
  interactions: number;
  ai: number;
  bots: number;
  events: number;
  /** Everything not identified as a crawler; see lib/tracker/humans.ts. */
  humans: number;
};

export type TrackerDailyPointShape = {
  date: string;
  events: number;
  pageviews: number;
  interactions: number;
  ai: number;
  bots: number;
  humans: number;
};

// Coerce a raw RPC row. bigint columns arrive as strings over PostgREST.
// `humans` is absent until the human-split migration is applied, in which
// case it is derived from the bucket totals (events - bots is exact there).
export function toSeriesRow(row: {
  day: string;
  pageviews: number | string;
  interactions: number | string;
  ai: number | string;
  bots: number | string;
  events: number | string;
  humans?: number | string | null;
}): TrackerSeriesRow {
  return {
    day: row.day,
    pageviews: Number(row.pageviews),
    interactions: Number(row.interactions),
    ai: Number(row.ai),
    bots: Number(row.bots),
    events: Number(row.events),
    humans: humansFrom(row),
  };
}

// The last `days` UTC calendar days, oldest first, as YYYY-MM-DD.
export function utcDayAxis(days: number, now = new Date()): string[] {
  const span = Math.max(1, days);
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - span + 1);

  return Array.from({ length: span }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

// Map the per-day series onto a zero-filled `days`-wide axis. Rows outside the
// window (should be none — the RPC applies the same window) are ignored.
export function buildDailyAxis(
  series: TrackerSeriesRow[],
  days: number,
  now = new Date(),
): TrackerDailyPointShape[] {
  const byDay = new Map<string, TrackerDailyPointShape>();
  for (const date of utcDayAxis(days, now)) {
    byDay.set(date, {
      date,
      events: 0,
      pageviews: 0,
      interactions: 0,
      ai: 0,
      bots: 0,
      humans: 0,
    });
  }

  for (const row of series) {
    const point = byDay.get(row.day);
    if (!point) continue;
    point.pageviews += row.pageviews;
    point.interactions += row.interactions;
    point.ai += row.ai;
    point.bots += row.bots;
    point.events += row.events;
    point.humans += row.humans;
  }

  // Older rollups predate the bucket table, so `events` can be 0 on a day that
  // clearly had traffic. Fall back to the event table's own totals. `humans`
  // is deliberately left alone: those event-table totals are bot-inclusive,
  // so there is no honest human figure for such a day.
  for (const point of byDay.values()) {
    if (point.events === 0) point.events = point.pageviews + point.interactions;
  }

  return Array.from(byDay.values());
}
