// Engaged visitors, shown in the UI as "Active users" (ACTIVE_USERS_LABEL in
// lib/tracker/humans.ts): the human visitors whose browser showed a person was there.
//
// WHY: "Human visitors" counts every visitor id whose user agent did not give
// it away. Swarms that open each page in a fresh headless browser with a
// current Chrome UA pass that test by the hundred thousand (nichedb.dev: 234,792
// "human visitors" in 30 days, 268 with two page views in a day). stats.js now
// sends one `engaged` beacon per page view on real input (a trusted
// pointerdown, keydown, touchstart or wheel) or after 10 seconds visible and
// focused, never when navigator.webdriver is set, and the visitor rollup marks
// the visitor engaged for that UTC day.
//
// The rule that matters on the server: engaged is never counted for a bot. A
// beacon on the bot side (user agent, declared agent, scripted cap) does not
// mark the row, and a row that flips to bot loses the mark. Mirrored by
// tracker_touch_visitor in
// supabase/migrations/20261125120000_tracker_engaged_visitors.sql.

import { ACTIVE_RATE_LABEL, type TrackerKind } from "@/lib/tracker/humans";

/** The beacon type stats.js sends. */
export const ENGAGED_EVENT = "engaged";

/** stats.js thresholds, kept here so the docs and the definition agree. */
export const ENGAGED_VISIBLE_MS = 10_000;
export const ENGAGED_INPUT_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

/** The UTC day the engaged beacon started being recorded in production. */
export const ENGAGED_SINCE = "2026-11-25";
export const ENGAGED_SINCE_LABEL = "25 Nov 2026";
export const ENGAGED_CAPTION = `Active users counted from ${ENGAGED_SINCE_LABEL}; earlier visitors read as not active.`;

/** Whether this beacon (after categorizing) may mark its visitor engaged. */
export function engagedFromBeacon(event: string, kind: TrackerKind): boolean {
  return kind === "human" && event === ENGAGED_EVENT;
}

/**
 * The engaged flag a visitor row ends the beacon with. Same rule as the SQL:
 * sticky once set, but only while the row is human.
 */
export function nextEngaged(prev: boolean, beaconEngaged: boolean, rowKind: TrackerKind): boolean {
  if (rowKind === "bot") return false;
  return prev || beaconEngaged;
}

/**
 * Engaged visitors as a share of human visitors, 0-100 with one decimal.
 * null when there are no visitors (no rate, not 0%).
 */
export function engagedRate(engaged: number | null | undefined, visitors: number | null | undefined): number | null {
  if (engaged == null || visitors == null || !Number.isFinite(visitors) || visitors <= 0) return null;
  const e = Math.max(0, Math.min(engaged, visitors));
  return Math.round((e / visitors) * 1000) / 10;
}

/** "Active rate 12.5%", or null when there is no rate. */
export function engagedRateLabel(engaged: number | null | undefined, visitors: number | null | undefined): string | null {
  const rate = engagedRate(engaged, visitors);
  return rate === null ? null : `${ACTIVE_RATE_LABEL} ${rate}%`;
}

/**
 * Whether a window of `days` days ending today starts before the engaged
 * beacon existed, so its engaged figure undercounts and needs the caption.
 */
export function engagedPartial(days: number, now = new Date()): boolean {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - Math.max(1, days) + 1);
  return start.toISOString().slice(0, 10) < ENGAGED_SINCE;
}
