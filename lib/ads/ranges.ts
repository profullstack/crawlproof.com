// Stock-chart style time ranges for the advertiser dashboard.
//
// Each range fixes both the window and the bucket width, chosen so every range
// lands in the 30–90 point band: fewer and a line chart reads as a bar chart,
// more and buckets fall below one pixel on a narrow card. That also keeps the
// account-wide series comfortably under PostgREST's 1000-row response cap.

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type RangeId = "1h" | "4h" | "1d" | "1w" | "1m" | "3m" | "1y" | "all";

export type RangeDef = {
  id: RangeId;
  /** Tab text — terse, the way a trading UI labels these. */
  label: string;
  /** Spelled out for the tab's title/aria-label. */
  hint: string;
  /** Window length in seconds; null means all time. */
  windowSeconds: number | null;
  /** Bucket width in seconds. */
  bucketSeconds: number;
  /** How to format a bucket on the x-axis and in the tooltip. */
  tick: "time" | "datetime" | "date" | "month";
};

export const RANGES: RangeDef[] = [
  { id: "1h", label: "1H", hint: "Last hour", windowSeconds: HOUR, bucketSeconds: MIN, tick: "time" },
  { id: "4h", label: "4H", hint: "Last 4 hours", windowSeconds: 4 * HOUR, bucketSeconds: 5 * MIN, tick: "time" },
  { id: "1d", label: "1D", hint: "Last 24 hours", windowSeconds: DAY, bucketSeconds: 30 * MIN, tick: "time" },
  { id: "1w", label: "1W", hint: "Last 7 days", windowSeconds: 7 * DAY, bucketSeconds: 4 * HOUR, tick: "datetime" },
  { id: "1m", label: "1M", hint: "Last 30 days", windowSeconds: 30 * DAY, bucketSeconds: DAY, tick: "date" },
  { id: "3m", label: "3M", hint: "Last 90 days", windowSeconds: 90 * DAY, bucketSeconds: DAY, tick: "date" },
  { id: "1y", label: "1Y", hint: "Last 12 months", windowSeconds: 365 * DAY, bucketSeconds: 7 * DAY, tick: "month" },
  { id: "all", label: "ALL", hint: "All time", windowSeconds: null, bucketSeconds: 7 * DAY, tick: "month" },
];

export const DEFAULT_RANGE: RangeId = "1m";

const BY_ID = new Map(RANGES.map((r) => [r.id, r]));

/**
 * Resolve a `?range=` search param to a range definition.
 *
 * Anything unrecognised falls back to the default rather than throwing — the
 * value is user-controlled via the URL, and a bad one should show the normal
 * dashboard, not a 500.
 */
export function resolveRange(raw: string | string[] | undefined): RangeDef {
  const key = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase().trim();
  return (key && BY_ID.get(key as RangeId)) || BY_ID.get(DEFAULT_RANGE)!;
}

/** Start of the window as an ISO timestamp, or null for all time. */
export function rangeSince(range: RangeDef, now: Date = new Date()): string | null {
  if (range.windowSeconds == null) return null;
  return new Date(now.getTime() - range.windowSeconds * 1000).toISOString();
}

/**
 * Zero-filled bucket axis for the range, oldest first.
 *
 * Buckets are aligned to the epoch so they match SQL's
 * `date_bin(step, ts, 'epoch')` — otherwise every point would miss its slot by
 * the offset between "now" and the epoch grid.
 */
export function bucketAxis(range: RangeDef, now: Date = new Date()): number[] {
  const stepMs = range.bucketSeconds * 1000;
  const endMs = Math.floor(now.getTime() / stepMs) * stepMs;
  if (range.windowSeconds == null) return [endMs];
  // Start at the bucket the window's first instant falls into, not at
  // `endMs - window`. Those differ whenever the window start lands mid-bucket,
  // which it does for every range coarser than a minute: the RPC filters rows
  // on `ts >= p_since` and then date_bins them, so it emits a partial leading
  // bucket. An axis one bucket short dropped it — getAccountSeries skips any
  // row with no matching point — and up to a full bucket of real delivery
  // vanished from the chart and the headline totals alike. The leading bucket
  // is partial by construction, exactly as the trailing one already is.
  const startMs = Math.floor((now.getTime() - range.windowSeconds * 1000) / stepMs) * stepMs;
  const out: number[] = [];
  for (let t = startMs; t <= endMs; t += stepMs) out.push(t);
  return out;
}

/** Snap an arbitrary timestamp onto the same epoch-aligned grid. */
export function bucketOf(iso: string, range: RangeDef): number {
  const stepMs = range.bucketSeconds * 1000;
  return Math.floor(new Date(iso).getTime() / stepMs) * stepMs;
}

/** Axis/tooltip label for a bucket, at the granularity the range implies. */
export function formatBucket(ms: number, tick: RangeDef["tick"]): string {
  const d = new Date(ms);
  switch (tick) {
    case "time":
      return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    case "datetime":
      return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" });
    case "date":
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    case "month":
      return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
}
