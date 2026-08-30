// Timeframe tabs for the project stats graphs.
//
// Two data sources sit behind these keys. Windows of a day or less are served
// from public.tracker_events, the raw row-per-event table — which /api/track
// prunes at 24h, so nothing shorter than a day can come from anywhere else and
// nothing longer can come from here. Windows above a day are served from the
// *_daily_stats rollups, whose finest resolution is one UTC calendar day.
//
// `minutes` is set on the raw ranges, `days` on the rollup ranges; which field
// is present is what the API route switches on, so they are deliberately
// mutually exclusive rather than one being derived from the other.

export type TrackerRangeKey = "1h" | "4h" | "1d" | "1w" | "1m" | "1y" | "all";

export type TrackerRange = {
  key: TrackerRangeKey;
  /** Tab label. */
  label: string;
  /** Long form, for the panel subtitle and the tab's title attribute. */
  description: string;
  /** Set on raw-event ranges (<= 24h). */
  minutes?: number;
  /** Set on rollup ranges (> 24h). `days: 0` means "all history". */
  days?: number;
  /** Series bucket width, raw ranges only. */
  bucketSeconds?: number;
};

export const TRACKER_RANGES: TrackerRange[] = [
  {
    key: "1h",
    label: "1H",
    description: "Last hour, 5-minute buckets",
    minutes: 60,
    bucketSeconds: 300,
  },
  {
    key: "4h",
    label: "4H",
    description: "Last 4 hours, 15-minute buckets",
    minutes: 240,
    bucketSeconds: 900,
  },
  {
    key: "1d",
    label: "1D",
    description: "Last 24 hours, hourly buckets",
    minutes: 1440,
    bucketSeconds: 3600,
  },
  { key: "1w", label: "1W", description: "Last 7 days, daily", days: 7 },
  { key: "1m", label: "1M", description: "Last 30 days, daily", days: 30 },
  { key: "1y", label: "1Y", description: "Last 365 days, daily", days: 365 },
  { key: "all", label: "All", description: "All history, daily", days: 0 },
];

export const DEFAULT_TRACKER_RANGE: TrackerRangeKey = "1m";

const BY_KEY = new Map(TRACKER_RANGES.map((r) => [r.key, r]));

export function trackerRange(key: string | null | undefined): TrackerRange {
  return (
    BY_KEY.get((key ?? "") as TrackerRangeKey) ??
    BY_KEY.get(DEFAULT_TRACKER_RANGE)!
  );
}

/** True when the range is served from tracker_events rather than the rollups. */
export function isRawRange(range: TrackerRange): boolean {
  return typeof range.minutes === "number";
}

// Device type / browser / OS live only in tracker_device_daily_stats — the raw
// event row carries a user_agent string but no parsed columns — so those three
// panels cannot offer a sub-day window. They get the rollup ranges only, with
// "1D" meaning today's UTC rollup rather than a rolling 24h. Exit pages are
// tracked per session against a `last_day` date, not a timestamp, so they are
// rollup-only for the same reason.
export const ROLLUP_ONLY_RANGES: TrackerRangeKey[] = [
  "1d",
  "1w",
  "1m",
  "1y",
  "all",
];

export const PANEL_RANGE_KEYS: Record<string, TrackerRangeKey[]> = {
  devices: ROLLUP_ONLY_RANGES,
  browsers: ROLLUP_ONLY_RANGES,
  operatingSystems: ROLLUP_ONLY_RANGES,
  exitPages: ROLLUP_ONLY_RANGES,
};

// These panels answer "1D" from today's UTC rollup, so the shared description
// ("Last 24 hours") would promise a rolling window they cannot serve. Relabel
// it here, where the list is already being narrowed, so the tab tooltip
// describes the number the panel actually returns.
const ROLLUP_1D_DESCRIPTION = "Today so far, UTC day";

export function rangesForPanel(panel: string): TrackerRange[] {
  const allowed = PANEL_RANGE_KEYS[panel];
  if (!allowed) return TRACKER_RANGES;
  return TRACKER_RANGES.filter((r) => allowed.includes(r.key)).map((r) =>
    r.key === "1d" ? { ...r, description: ROLLUP_1D_DESCRIPTION } : r,
  );
}
