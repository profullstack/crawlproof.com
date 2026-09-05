// Per-project window totals from tracker_project_totals, and the portfolio
// roll-up of them. Pulled out of the analytics page so the arithmetic behind
// the headline tiles — humans first, bots apart — is testable without a
// database.

import { computeTrend, type Trend } from "@/lib/tracker/trend";
import { humansFrom } from "@/lib/tracker/humans";

/** One row of tracker_project_totals. bigint columns arrive as strings. */
export type TotalsRow = {
  project_id: string;
  events: number | string;
  ai: number | string;
  bots: number | string;
  prev_events: number | string;
  prev_ai: number | string;
  prev_bots: number | string;
  /** Added by the human-split migration; absent until it is applied. */
  humans?: number | string | null;
  prev_humans?: number | string | null;
};

export type ProjectTotals = {
  events: number;
  ai: number;
  bots: number;
  /** Everything not identified as a crawler; includes AI referrals. */
  humans: number;
  prevEvents: number;
  prevAi: number;
  prevBots: number;
  prevHumans: number;
};

export function emptyTotals(): ProjectTotals {
  return {
    events: 0,
    ai: 0,
    bots: 0,
    humans: 0,
    prevEvents: 0,
    prevAi: 0,
    prevBots: 0,
    prevHumans: 0,
  };
}

export function toProjectTotals(row: TotalsRow): ProjectTotals {
  return {
    events: Number(row.events),
    ai: Number(row.ai),
    bots: Number(row.bots),
    humans: humansFrom(row),
    prevEvents: Number(row.prev_events),
    prevAi: Number(row.prev_ai),
    prevBots: Number(row.prev_bots),
    prevHumans: humansFrom({
      humans: row.prev_humans,
      events: row.prev_events,
      bots: row.prev_bots,
    }),
  };
}

export function sumTotals(all: Iterable<ProjectTotals>): ProjectTotals {
  const out = emptyTotals();
  for (const t of all) {
    out.events += t.events;
    out.ai += t.ai;
    out.bots += t.bots;
    out.humans += t.humans;
    out.prevEvents += t.prevEvents;
    out.prevAi += t.prevAi;
    out.prevBots += t.prevBots;
    out.prevHumans += t.prevHumans;
  }
  return out;
}

export type TotalsTrends = {
  humans: Trend;
  ai: Trend;
  bots: Trend;
  events: Trend;
};

/** Window-over-window trend for each headline figure. */
export function totalsTrends(t: ProjectTotals): TotalsTrends {
  return {
    humans: computeTrend(t.humans, t.prevHumans),
    ai: computeTrend(t.ai, t.prevAi),
    bots: computeTrend(t.bots, t.prevBots),
    events: computeTrend(t.events, t.prevEvents),
  };
}
