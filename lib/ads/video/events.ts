// Playback measurement for a pre-roll: what the player reports back.
//
// The impression ledger says an ad was chosen. Only the player can say it
// started, how far it got, and whether it ever rendered a frame — and a video
// that is chosen and never seen looks identical to one watched to the end
// unless something writes these rows.
//
// Everything here is best-effort by construction. A beacon arrives from a
// media element in a browser, over an unreliable network, often during
// teardown; losing one must never cost the viewer anything and must never
// fail a request. So this module validates hard, swallows conflicts, and
// reports how many rows it accepted rather than throwing.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Every event the schema's CHECK will accept. */
export const VIDEO_EVENT_TYPES = [
  "asset_requested",
  "start",
  "first_quartile",
  "midpoint",
  "third_quartile",
  "complete",
  "click",
  "error",
  "abandon",
  "entitlement_changed",
  "fail_open",
  "text_start",
  "text_complete",
] as const;

export type VideoEventType = (typeof VIDEO_EVENT_TYPES)[number];

/**
 * Progress events that may happen at most once per decision.
 *
 * The database enforces this with a partial unique index; the set is repeated
 * here so the writer knows which 23505 is the expected one (a retried beacon)
 * rather than a bug.
 */
export const ONCE_ONLY: ReadonlySet<string> = new Set([
  "start",
  "first_quartile",
  "midpoint",
  "third_quartile",
  "complete",
  "text_start",
  "text_complete",
]);

/**
 * The event that ends a session, and the outcome it implies.
 *
 * `outcome` is terminal: the first one to arrive wins and later reports cannot
 * revise it. A player that errors after completing has still completed, and a
 * viewer who closes the tab on a finished ad did not abandon it.
 */
const TERMINAL: Record<string, string> = {
  complete: "completed",
  text_complete: "completed",
  abandon: "abandoned",
  error: "error",
  fail_open: "fail_open",
  entitlement_changed: "entitlement_changed",
};

export type VideoEventInput = {
  eventId: string;
  type: VideoEventType;
  mediaTimeMs: number | null;
  playedMs: number | null;
  source: string;
  errorReason: string | null;
  clientTs: string | null;
};

export type ParsedBatch = { decisionId: string; events: VideoEventInput[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A player reporting twenty events for one five-second ad is either broken or
// probing; either way the useful ones are at the front.
const MAX_EVENTS = 20;

function isEventType(v: unknown): v is VideoEventType {
  return typeof v === "string" && (VIDEO_EVENT_TYPES as readonly string[]).includes(v);
}

/**
 * Milliseconds, or null.
 *
 * A negative or non-finite duration is dropped rather than clamped to zero: a
 * clamped value is indistinguishable from a real measurement of zero, and the
 * column is nullable precisely so "the player did not say" can be recorded as
 * itself. The ceiling is a day, well past any break, and exists so a bad
 * client cannot write a number that overflows the integer column.
 */
function ms(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.min(Math.round(v), 86_400_000);
}

function str(v: unknown, cap: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, cap);
  return t.length ? t : null;
}

/** An ISO timestamp the client claims, or null. Never trusted for ordering. */
function clientTs(v: unknown): string | null {
  const raw = str(v, 40);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Parse a beacon body.
 *
 * Accepts both the batch form the helper sends and a single bare event, since
 * `navigator.sendBeacon` during teardown is easiest to write as one event and
 * there is no reason to make that the harder path.
 */
export function parseEventBatch(body: unknown): ParsedBatch | { error: string } {
  if (!body || typeof body !== "object") return { error: "Body must be JSON." };
  const obj = body as Record<string, unknown>;

  const decisionId = str(obj.decision ?? obj.decisionId, 64);
  if (!decisionId || !UUID_RE.test(decisionId)) return { error: "A decision id is required." };

  const raw = Array.isArray(obj.events)
    ? obj.events
    : isEventType(obj.type ?? obj.event)
      ? [obj]
      : null;
  if (!raw || raw.length === 0) return { error: "No events." };

  const events: VideoEventInput[] = [];
  for (const item of raw.slice(0, MAX_EVENTS)) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const type = e.type ?? e.event;
    if (!isEventType(type)) continue;
    // A once-only event keys on its own type, so a client that forgets to mint
    // an id still dedupes correctly — and one that invents a fresh id per retry
    // cannot slip a second `start` past the event-id index.
    const eventId = ONCE_ONLY.has(type) ? type : (str(e.id ?? e.eventId, 64) ?? `${type}:${crypto.randomUUID()}`);
    events.push({
      eventId,
      type,
      mediaTimeMs: ms(e.mediaTimeMs ?? e.media_time_ms),
      playedMs: ms(e.playedMs ?? e.played_ms),
      source: str(e.source ?? e.measurementSource, 40) ?? "media_element",
      errorReason: str(e.errorReason ?? e.error, 200),
      clientTs: clientTs(e.ts ?? e.clientTs),
    });
  }

  if (!events.length) return { error: "No recognised events." };
  return { decisionId, events };
}

type Row = {
  decision_id: string;
  event_id: string;
  event_type: string;
  media_time_ms: number | null;
  played_ms: number | null;
  measurement_source: string;
  error_reason: string | null;
  client_ts: string | null;
};

function toRow(decisionId: string, e: VideoEventInput): Row {
  return {
    decision_id: decisionId,
    event_id: e.eventId,
    event_type: e.type,
    media_time_ms: e.mediaTimeMs,
    played_ms: e.playedMs,
    measurement_source: e.source,
    error_reason: e.errorReason,
    client_ts: e.clientTs,
  };
}

/** A duplicate beacon, which is the expected case, not a failure. */
function isDuplicate(err: { code?: string } | null): boolean {
  return err?.code === "23505";
}

export type RecordResult = { accepted: number; duplicates: number };

/**
 * Write a batch and settle the decision's outcome.
 *
 * The batch is attempted as one insert and falls back to row-at-a-time only
 * when it fails, because the overwhelmingly common failure is one duplicate in
 * a batch of three and losing the other two to it would silently lose real
 * measurements.
 */
export async function recordVideoEvents(
  sb: SupabaseClient,
  batch: ParsedBatch,
): Promise<RecordResult> {
  const rows = batch.events.map((e) => toRow(batch.decisionId, e));
  let accepted = 0;
  let duplicates = 0;

  const { error } = await sb.from("ad_video_events").insert(rows);
  if (!error) {
    accepted = rows.length;
  } else {
    for (const row of rows) {
      const { error: one } = await sb.from("ad_video_events").insert(row);
      if (!one) accepted += 1;
      else if (isDuplicate(one)) duplicates += 1;
      // Anything else — a decision that does not exist, a check violation —
      // is dropped. The beacon is not the place to argue about it.
    }
  }

  await settleOutcome(sb, batch);
  return { accepted, duplicates };
}

/**
 * Record the session's terminal state, once.
 *
 * Filtered on `outcome is null` rather than read-then-write: two beacons can
 * race (a `complete` and an `abandon` from a closing tab), and the filter makes
 * the first writer win in the database instead of in whichever request happened
 * to read first.
 */
async function settleOutcome(sb: SupabaseClient, batch: ParsedBatch): Promise<void> {
  const terminal = batch.events.map((e) => TERMINAL[e.type]).find(Boolean);
  if (!terminal) return;
  await sb
    .from("ad_video_decisions")
    .update({ outcome: terminal })
    .eq("id", batch.decisionId)
    .is("outcome", null);
}
