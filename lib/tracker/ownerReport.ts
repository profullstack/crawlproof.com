// One account's sites summarised for a period, for a caller that writes a
// report rather than draws a dashboard (CoinPay's business report).
//
// Built from the same projectStats the CLI reads, so the numbers match what
// the owner sees on crawlproof.com. Always scoped by owner: the project list
// comes from listProjects(userId) and nothing in the request can widen it.

import type { SupabaseClient } from "@supabase/supabase-js";

import { listProjects, projectStats, type ProjectRow, type StatsAnswer } from "@/lib/tracker/apiStats";
import type { ListItem } from "@/lib/tracker/panels";
import { trackerRange, type TrackerRangeKey } from "@/lib/tracker/ranges";
import { whoToKind } from "@/lib/tracker/who";

/** A report covers a week or a month; anything finer is a dashboard question. */
export const REPORT_RANGES: TrackerRangeKey[] = ["1w", "1m"];
/** Enough for any real account, small enough that one call cannot fan out. */
export const REPORT_MAX_SITES = 25;
const TOP_N = 5;
const CONCURRENCY = 3;

export type SiteReport = {
  id: string;
  name: string;
  url: string;
  /** Distinct human visitors; null when the visitor rollup could not be read. */
  visitors: number | null;
  pageviews: number | null;
  /** Unfiltered beacon mix over the window. */
  hits: { humans: number; bots: number; ai: number };
  top_pages: ListItem[];
  top_sources: ListItem[];
  /** Human events, second half of the window against the first. */
  trend: { first_half: number; second_half: number; change_pct: number | null };
};

export type OwnerReport = {
  range: TrackerRangeKey;
  generated_at: string;
  sites: SiteReport[];
  /** Sites past REPORT_MAX_SITES that were left out. */
  truncated: number;
  totals: { visitors: number; pageviews: number; humans: number; bots: number; ai: number };
};

export function parseReportRange(raw: string | null): TrackerRangeKey | null {
  if (raw === null || raw === "") return "1w";
  return (REPORT_RANGES as string[]).includes(raw) ? (raw as TrackerRangeKey) : null;
}

export function trendOf(series: StatsAnswer["series"]): SiteReport["trend"] {
  const points = series ?? [];
  const mid = Math.floor(points.length / 2);
  const sum = (xs: typeof points) => xs.reduce((n, p) => n + p.humans, 0);
  const first = sum(points.slice(0, mid));
  const second = sum(points.slice(mid));
  return {
    first_half: first,
    second_half: second,
    change_pct: first > 0 ? Math.round(((second - first) / first) * 1000) / 10 : null,
  };
}

export function siteReport(stats: StatsAnswer): SiteReport {
  const mix = stats.mix ?? { humans: 0, bots: 0, ai: 0, events: 0 };
  return {
    id: stats.project.id,
    name: stats.project.name,
    url: stats.project.url,
    visitors: stats.totals.visitors,
    pageviews: stats.totals.pageviews,
    hits: { humans: mix.humans, bots: mix.bots, ai: mix.ai },
    top_pages: stats.pages.slice(0, TOP_N),
    top_sources: stats.sources.slice(0, TOP_N),
    trend: trendOf(stats.series),
  };
}

export async function ownerReport(
  sb: SupabaseClient,
  userId: string,
  rangeKey: TrackerRangeKey,
): Promise<{ ok: true; report: OwnerReport } | { ok: false; status: number; error: string }> {
  const listed = await listProjects(sb, userId);
  if (!listed.ok) return listed;

  const projects: ProjectRow[] = listed.projects.slice(0, REPORT_MAX_SITES);
  const range = trackerRange(rangeKey);
  const kind = whoToKind("humans");
  const sites: SiteReport[] = [];
  for (let i = 0; i < projects.length; i += CONCURRENCY) {
    const batch = projects.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((p) =>
        projectStats(sb, p, range, kind, "humans", true)
          .then(siteReport)
          .catch(() => null),
      ),
    );
    for (const r of results) if (r) sites.push(r);
  }

  const totals = { visitors: 0, pageviews: 0, humans: 0, bots: 0, ai: 0 };
  for (const s of sites) {
    totals.visitors += s.visitors ?? 0;
    totals.pageviews += s.pageviews ?? 0;
    totals.humans += s.hits.humans;
    totals.bots += s.hits.bots;
    totals.ai += s.hits.ai;
  }

  return {
    ok: true,
    report: {
      range: rangeKey,
      generated_at: new Date().toISOString(),
      sites,
      truncated: Math.max(0, listed.projects.length - projects.length),
      totals,
    },
  };
}
