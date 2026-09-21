// The scripted-visitor cap: the one rule that turns a browser being driven
// into a bot, applied per beacon by the ingest route.
//
// WHY: lib/tracker/categorize.ts can only call a hit a bot when the user
// agent says so. A headless Chrome with a stock UA is "human" by definition,
// and one was measured minting a fresh visitor id per page view (19k
// "visitors" on 19k page views in a day), another produced 398 events on 4
// page views, another 126 page views from one id. No person does that. The
// tracker_visitor_daily_stats rollup keeps per-visitor, per-day counts, so
// volume is a signal the classifier finally has.
//
// The caps are per visitor per UTC day and deliberately generous: a binge
// reader on a search-heavy site can reach 100 page views, and the cost of a
// false demotion (one real person counted as a bot for a day) is the same
// size as the cost of a miss (one script counted as a person for a day). The
// point is the tail, not the median.
//
// Mirrored by the defaults of tracker_touch_visitor in
// supabase/migrations/20260921120000_tracker_visitor_rollup.sql.

import { kindFromBucket, type TrackerKind } from "@/lib/tracker/humans";

/** More beacons than this from one visitor in one UTC day is a script. */
export const SCRIPTED_CAP_EVENTS = 500;
/** More page views than this from one visitor in one UTC day is a script. */
export const SCRIPTED_CAP_PAGEVIEWS = 200;

/** The bucket a demoted hit is counted under. Renders as "Bot · scripted". */
export const SCRIPTED_BUCKET = "bot:scripted";

/** What tracker_touch_visitor hands back after the increment. */
export type VisitorTouch = {
  kind: TrackerKind;
  events: number;
  pageviews: number;
};

/**
 * The bucket and kind a hit should be counted under once the visitor rollup
 * has had its say. A hit the user agent already made a bot is left alone. A
 * hit from a visitor the rollup has flipped to `bot` — by this beacon or an
 * earlier one today — is counted under bot:scripted, so every rollup the
 * route writes next lands on the bot side. Without a touch (no visitor id,
 * or the RPC failed) the bucket stands: the beacon must never fail closed
 * on a counter table hiccup.
 */
export function applyScriptedDemotion(
  bucket: string,
  touch: VisitorTouch | null,
): { bucket: string; kind: TrackerKind; demoted: boolean } {
  const kind = kindFromBucket(bucket);
  if (kind === "bot" || !touch || touch.kind !== "bot") {
    return { bucket, kind, demoted: false };
  }
  return { bucket: SCRIPTED_BUCKET, kind: "bot", demoted: true };
}

/** Coerce one RPC row; null when the shape is not what the migration returns. */
export function parseVisitorTouch(row: unknown): VisitorTouch | null {
  const r = (Array.isArray(row) ? row[0] : row) as
    | { kind?: unknown; events?: unknown; pageviews?: unknown }
    | null
    | undefined;
  if (!r || typeof r !== "object") return null;
  const kind = r.kind === "bot" ? "bot" : r.kind === "human" ? "human" : null;
  if (!kind) return null;
  const events = Number(r.events);
  const pageviews = Number(r.pageviews);
  return {
    kind,
    events: Number.isFinite(events) ? events : 0,
    pageviews: Number.isFinite(pageviews) ? pageviews : 0,
  };
}
