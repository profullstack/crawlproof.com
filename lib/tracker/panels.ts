// One place that turns (project, range, panel) into the shape a stats card
// renders.
//
// WHY here and not in the page: the stats page server-renders every panel at
// the default range, and /api/projects/:id/tracker-stats re-renders one panel
// when a timeframe tab is clicked. Both have to agree exactly — label
// formatting, top-N truncation, the zero-filled axis — or a tab click would
// silently reshape a chart that had not changed data. So the mapping lives
// once, and both callers pass their own Supabase client (the page's server
// client and the route handler's, both RLS-scoped to the signed-in user).
//
// Each panel picks its RPC from the range: raw tracker_events twins under a
// day, *_daily_stats rollups above it. See lib/tracker/ranges.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { bucketLabel } from "@/lib/tracker/categorize";
import { countryNameFromCode } from "@/lib/tracker/country";
import { buildDailyAxis, toSeriesRow } from "@/lib/tracker/series";
import {
  isRawRange,
  type TrackerRange,
} from "@/lib/tracker/ranges";

export type PanelKey =
  | "series"
  | "events"
  | "sources"
  | "pages"
  | "exitPages"
  | "referrers"
  | "actions"
  | "countries"
  | "cities"
  | "devices"
  | "browsers"
  | "operatingSystems";

export const PANEL_KEYS: PanelKey[] = [
  "series",
  "events",
  "sources",
  "pages",
  "exitPages",
  "referrers",
  "actions",
  "countries",
  "cities",
  "devices",
  "browsers",
  "operatingSystems",
];

export type ListItem = { label: string; value: number };

export type SeriesPoint = {
  date: string;
  events: number;
  pageviews: number;
  interactions: number;
  ai: number;
  bots: number;
};

export type SeriesPayload = {
  points: SeriesPoint[];
  /** "day" axis ticks are dates; "time" ticks are clock times. */
  granularity: "day" | "time";
};

export type PanelPayload = SeriesPayload | ListItem[];

type Sb = SupabaseClient<any, any, any>;

const TOP_N = 10;

// `days: 0` means all history; resolve it against the project's first rollup
// day so the axis is sized to real data instead of an arbitrary epoch. Capped
// at 10 years so one bad row cannot ask the chart for 100k points.
const MAX_ALL_DAYS = 3650;

export async function resolveDays(
  sb: Sb,
  projectId: string,
  range: TrackerRange,
): Promise<number> {
  if (range.days && range.days > 0) return range.days;
  const { data } = await sb.rpc("tracker_first_day", { p_project: projectId });
  const first = typeof data === "string" ? data : null;
  if (!first) return 30;
  const start = Date.parse(`${first}T00:00:00Z`);
  if (!Number.isFinite(start)) return 30;
  const spanDays = Math.floor((Date.now() - start) / 86_400_000) + 1;
  return Math.min(Math.max(spanDays, 1), MAX_ALL_DAYS);
}

// The four rollup-only panels (exit pages, devices, browsers, operating
// systems) offer the "1D" tab, but that range is defined with `minutes`, not
// `days` — it is a raw-event window for every other panel. Handing it to
// resolveDays finds no `days`, falls through to tracker_first_day and returns
// the project's entire history, so the 1D tab rendered All-time totals: on a
// site younger than 30 days, 1D, 1M and All were the same number. A sub-day
// window against a day-resolution rollup is one day — today's UTC rollup —
// which is exactly what ROLLUP_ONLY_RANGES already documents it to mean.
export function rollupDays(range: TrackerRange, days: number): number {
  return isRawRange(range) ? 1 : days;
}

/** Fetch one panel. Errors surface as an empty panel rather than a broken page. */
export async function fetchPanel(
  sb: Sb,
  projectId: string,
  panel: PanelKey,
  range: TrackerRange,
  days: number,
): Promise<PanelPayload> {
  const raw = isRawRange(range);
  const minutes = range.minutes ?? 1440;

  switch (panel) {
    case "series": {
      if (raw) {
        const { data } = await sb.rpc("tracker_recent_series", {
          p_project: projectId,
          p_minutes: minutes,
          p_bucket_seconds: range.bucketSeconds ?? 300,
        });
        return {
          points: buildBucketAxis(
            (data ?? []) as RecentSeriesRow[],
            minutes,
            range.bucketSeconds ?? 300,
          ),
          granularity: "time",
        };
      }
      const { data } = await sb.rpc("tracker_daily_series", {
        p_project: projectId,
        days,
      });
      const series = ((data ?? []) as Parameters<typeof toSeriesRow>[0][]).map(
        toSeriesRow,
      );
      return { points: buildDailyAxis(series, days), granularity: "day" };
    }

    case "sources": {
      const { data } = raw
        ? await sb.rpc("tracker_recent_bucket_totals", {
            p_project: projectId,
            p_minutes: minutes,
            lim: TOP_N,
          })
        : await sb.rpc("tracker_bucket_totals", {
            p_project: projectId,
            days,
            lim: TOP_N,
          });
      return ((data ?? []) as Array<{ bucket: string; total: number | string }>).map(
        (r) => ({ label: bucketLabel(r.bucket), value: Number(r.total) }),
      );
    }

    case "events": {
      const { data } = raw
        ? await sb.rpc("tracker_recent_event_mix", {
            p_project: projectId,
            p_minutes: minutes,
          })
        : await sb.rpc("tracker_event_mix", { p_project: projectId, days });
      return ((data ?? []) as Array<{ event: string; total: number | string }>)
        .map((r) => ({ label: eventLabel(r.event), value: Number(r.total) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, TOP_N);
    }

    case "pages": {
      const { data } = raw
        ? await sb.rpc("tracker_recent_top_pages", {
            p_project: projectId,
            p_minutes: minutes,
            lim: TOP_N,
          })
        : await sb.rpc("tracker_top_pages", {
            p_project: projectId,
            days,
            lim: TOP_N,
          });
      return (
        (data ?? []) as Array<{ page_path: string; total: number | string }>
      ).map((r) => ({ label: r.page_path || "/", value: Number(r.total) }));
    }

    case "exitPages": {
      // Rollup-only: tracker_exit_sessions keys on a date, not a timestamp.
      const { data } = await sb.rpc("tracker_top_exit_pages", {
        p_project: projectId,
        days: rollupDays(range, days),
        lim: TOP_N,
      });
      return (
        (data ?? []) as Array<{ page_path: string; total: number | string }>
      ).map((r) => ({ label: r.page_path || "/", value: Number(r.total) }));
    }

    case "referrers": {
      const { data } = raw
        ? await sb.rpc("tracker_recent_top_referrers", {
            p_project: projectId,
            p_minutes: minutes,
            lim: TOP_N,
          })
        : await sb.rpc("tracker_top_referrers", {
            p_project: projectId,
            days,
            lim: TOP_N,
          });
      return (
        (data ?? []) as Array<{ referrer_host: string; total: number | string }>
      ).map((r) => ({ label: r.referrer_host, value: Number(r.total) }));
    }

    case "actions": {
      const { data } = raw
        ? await sb.rpc("tracker_recent_top_actions", {
            p_project: projectId,
            p_minutes: minutes,
            lim: TOP_N,
          })
        : await sb.rpc("tracker_top_actions", {
            p_project: projectId,
            days,
            lim: TOP_N,
          });
      return (
        (data ?? []) as Array<{
          event: string;
          event_target: string;
          total: number | string;
        }>
      ).map((r) => ({
        label: `${eventLabel(r.event)} · ${r.event_target}`,
        value: Number(r.total),
      }));
    }

    case "countries": {
      const { data } = raw
        ? await sb.rpc("tracker_recent_top_countries", {
            p_project: projectId,
            p_minutes: minutes,
            lim: TOP_N,
          })
        : await sb.rpc("tracker_top_countries", {
            p_project: projectId,
            days,
            lim: TOP_N,
          });
      return (
        (data ?? []) as Array<{
          country_code: string;
          country_name: string;
          total: number | string;
        }>
      )
        .map((r) => ({
          label:
            r.country_name || r.country_code
              ? `${r.country_name || countryNameFromCode(r.country_code) || r.country_code}${r.country_code ? ` (${r.country_code})` : ""}`
              : "",
          value: Number(r.total),
        }))
        .filter((it) => it.label);
    }

    case "cities": {
      const { data } = raw
        ? await sb.rpc("tracker_recent_top_cities", {
            p_project: projectId,
            p_minutes: minutes,
            lim: TOP_N,
          })
        : await sb.rpc("tracker_top_cities", {
            p_project: projectId,
            days,
            lim: TOP_N,
          });
      return (
        (data ?? []) as Array<{
          city: string;
          region_code: string;
          region_name: string;
          country_code: string;
          country_name: string;
          total: number | string;
        }>
      )
        .map((r) => {
          const region = r.region_code || r.region_name;
          const country = r.country_code || r.country_name;
          return {
            label: [r.city, region, country].filter(Boolean).join(", "),
            value: Number(r.total),
          };
        })
        .filter((it) => it.label);
    }

    case "devices":
    case "browsers":
    case "operatingSystems": {
      // Rollup-only: the raw event row keeps a user_agent string but no parsed
      // device_type / browser / os columns.
      const { data } = await sb.rpc("tracker_device_totals", {
        p_project: projectId,
        days: rollupDays(range, days),
      });
      const rows = (
        (data ?? []) as Array<{
          device_type: string;
          browser: string;
          os: string;
          total: number | string;
        }>
      ).map((r) => ({
        device_type: r.device_type,
        browser: r.browser,
        os: r.os,
        count: Number(r.total),
      }));
      if (panel === "devices") {
        return topDeviceItems(rows, (row) => deviceTypeLabel(row.device_type));
      }
      if (panel === "browsers") return topDeviceItems(rows, (row) => row.browser);
      return topDeviceItems(rows, (row) => row.os);
    }
  }
}

/** Fetch several panels for one range, in parallel. */
export async function fetchPanels(
  sb: Sb,
  projectId: string,
  panels: PanelKey[],
  range: TrackerRange,
): Promise<Record<string, PanelPayload>> {
  const days = await resolveDays(sb, projectId, range);
  const results = await Promise.all(
    panels.map((p) => fetchPanel(sb, projectId, p, range, days)),
  );
  return Object.fromEntries(panels.map((p, i) => [p, results[i]]));
}

type RecentSeriesRow = {
  ts: string;
  pageviews: number | string;
  interactions: number | string;
  ai: number | string;
  bots: number | string;
  events: number | string;
};

// Zero-fill the sub-day series across every bucket in the window. The RPC only
// returns buckets that saw traffic, and a line that skips its quiet buckets
// reads as a smooth decline rather than the gap it actually is — the exact
// misreading these tabs exist to prevent.
export function buildBucketAxis(
  rows: RecentSeriesRow[],
  minutes: number,
  bucketSeconds: number,
  now = new Date(),
): SeriesPoint[] {
  const step = Math.max(60, bucketSeconds) * 1000;
  const end = Math.floor(now.getTime() / step) * step;
  // The window `now - minutes .. now` starts inside its oldest bucket, so the
  // number of bucket *starts* it covers is one more than it divides into —
  // 11:00 through 12:00 is 13 five-minute buckets, not 12. Sizing this by
  // division alone dropped the oldest bucket on every sub-day tab, which the
  // RPC had happily returned. The final bucket is the in-progress one.
  const count = Math.max(1, Math.floor((minutes * 60_000) / step) + 1);
  const start = end - (count - 1) * step;

  const byTs = new Map<number, SeriesPoint>();
  for (let t = start; t <= end; t += step) {
    byTs.set(t, {
      date: new Date(t).toISOString(),
      events: 0,
      pageviews: 0,
      interactions: 0,
      ai: 0,
      bots: 0,
    });
  }

  for (const row of rows) {
    const t = Date.parse(row.ts);
    if (!Number.isFinite(t)) continue;
    const point = byTs.get(Math.floor(t / step) * step);
    if (!point) continue;
    point.pageviews += Number(row.pageviews);
    point.interactions += Number(row.interactions);
    point.ai += Number(row.ai);
    point.bots += Number(row.bots);
    point.events += Number(row.events);
  }

  return Array.from(byTs.values());
}

export function topDeviceItems(
  rows: Array<{ device_type: string; browser: string; os: string; count: number }>,
  labelFor: (row: {
    device_type: string;
    browser: string;
    os: string;
    count: number;
  }) => string,
): ListItem[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    const label = labelFor(row);
    if (!label) continue;
    map.set(label, (map.get(label) ?? 0) + row.count);
  }
  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_N);
}

export function deviceTypeLabel(deviceType: string) {
  switch (deviceType) {
    case "mobile":
      return "Mobile";
    case "tablet":
      return "Tablet";
    case "desktop":
      return "Desktop";
    case "bot":
      return "Bot";
    default:
      return "";
  }
}

export function eventLabel(event: string) {
  return event
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
