import { describe, expect, it } from "vitest";
import { ONCE_ONLY, parseEventBatch, recordVideoEvents } from "@/lib/ads/video/events";

const DECISION = "11111111-2222-4333-8444-555555555555";

/**
 * A Supabase stand-in that records inserts and can be told to reject specific
 * rows the way Postgres would — the duplicate path is the one that matters,
 * because it is the common case rather than the exception.
 */
function db(opts: { rejectTypes?: string[]; rejectBatch?: boolean } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const reject = new Set(opts.rejectTypes ?? []);
  return {
    inserted,
    updates,
    from(table: string) {
      if (table === "ad_video_events") {
        return {
          async insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
            const list = Array.isArray(rows) ? rows : [rows];
            const clash = list.find((r) => reject.has(String(r.event_type)));
            if (clash || (Array.isArray(rows) && opts.rejectBatch)) {
              return { error: { code: "23505" } };
            }
            inserted.push(...list);
            return { error: null };
          },
        };
      }
      const patch: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        update(values: Record<string, unknown>) {
          Object.assign(patch, values);
          return b;
        },
        eq(col: string, val: unknown) {
          patch[`eq:${col}`] = val;
          return b;
        },
        is(col: string, val: unknown) {
          patch[`is:${col}`] = val;
          updates.push({ ...patch });
          return Promise.resolve({ error: null });
        },
      });
      return b;
    },
  };
}

describe("parseEventBatch", () => {
  it("rejects a body with no decision id", () => {
    expect(parseEventBatch({ events: [{ type: "start" }] })).toEqual({
      error: "A decision id is required.",
    });
  });

  it("rejects a decision id that is not a uuid", () => {
    const out = parseEventBatch({ decision: "../../etc/passwd", events: [{ type: "start" }] });
    expect(out).toHaveProperty("error");
  });

  it("accepts a single bare event as well as a batch", () => {
    const one = parseEventBatch({ decision: DECISION, type: "start" });
    expect("events" in one && one.events).toHaveLength(1);
    const many = parseEventBatch({
      decision: DECISION,
      events: [{ type: "start" }, { type: "midpoint" }],
    });
    expect("events" in many && many.events).toHaveLength(2);
  });

  it("drops event types the schema would reject rather than failing the batch", () => {
    const out = parseEventBatch({
      decision: DECISION,
      events: [{ type: "start" }, { type: "drop table" }, { type: "complete" }],
    });
    expect("events" in out && out.events.map((e) => e.type)).toEqual(["start", "complete"]);
  });

  it("keys a once-only event on its type, so a retry with a fresh id still dedupes", () => {
    const out = parseEventBatch({
      decision: DECISION,
      events: [{ type: "start", id: "whatever-the-client-invented" }],
    });
    expect("events" in out && out.events[0].eventId).toBe("start");
    expect(ONCE_ONLY.has("start")).toBe(true);
  });

  it("gives a repeatable event its own id so two of them can coexist", () => {
    const out = parseEventBatch({
      decision: DECISION,
      events: [{ type: "click" }, { type: "click" }],
    });
    if (!("events" in out)) throw new Error("expected events");
    expect(out.events[0].eventId).not.toBe(out.events[1].eventId);
  });

  it("drops a negative duration instead of clamping it to a real-looking zero", () => {
    const out = parseEventBatch({
      decision: DECISION,
      events: [{ type: "midpoint", playedMs: -5, mediaTimeMs: 2500 }],
    });
    if (!("events" in out)) throw new Error("expected events");
    expect(out.events[0].playedMs).toBeNull();
    expect(out.events[0].mediaTimeMs).toBe(2500);
  });

  it("caps a runaway batch", () => {
    const events = Array.from({ length: 50 }, () => ({ type: "click" }));
    const out = parseEventBatch({ decision: DECISION, events });
    expect("events" in out && out.events.length).toBe(20);
  });
});

describe("recordVideoEvents", () => {
  it("writes a clean batch in one insert", async () => {
    const sb = db();
    const parsed = parseEventBatch({
      decision: DECISION,
      events: [{ type: "start" }, { type: "midpoint" }],
    });
    if (!("events" in parsed)) throw new Error("expected events");
    const res = await recordVideoEvents(sb as never, parsed);
    expect(res).toEqual({ accepted: 2, duplicates: 0 });
    expect(sb.inserted.map((r) => r.event_type)).toEqual(["start", "midpoint"]);
  });

  it("keeps the good rows when one row in the batch is a duplicate", async () => {
    // The batch insert fails as a whole, then the retry writes the survivors.
    const sb = db({ rejectTypes: ["start"] });
    const parsed = parseEventBatch({
      decision: DECISION,
      events: [{ type: "start" }, { type: "midpoint" }, { type: "complete" }],
    });
    if (!("events" in parsed)) throw new Error("expected events");
    const res = await recordVideoEvents(sb as never, parsed);
    expect(res).toEqual({ accepted: 2, duplicates: 1 });
    expect(sb.inserted.map((r) => r.event_type)).toEqual(["midpoint", "complete"]);
  });

  it("settles the decision outcome from a terminal event, only when null", async () => {
    const sb = db();
    const parsed = parseEventBatch({ decision: DECISION, events: [{ type: "complete" }] });
    if (!("events" in parsed)) throw new Error("expected events");
    await recordVideoEvents(sb as never, parsed);
    expect(sb.updates).toHaveLength(1);
    expect(sb.updates[0]).toMatchObject({
      outcome: "completed",
      "eq:id": DECISION,
      "is:outcome": null,
    });
  });

  it("does not touch the outcome for a progress event", async () => {
    const sb = db();
    const parsed = parseEventBatch({ decision: DECISION, events: [{ type: "midpoint" }] });
    if (!("events" in parsed)) throw new Error("expected events");
    await recordVideoEvents(sb as never, parsed);
    expect(sb.updates).toHaveLength(0);
  });

  it("prefers the completion when a closing tab reports complete and abandon together", async () => {
    const sb = db();
    const parsed = parseEventBatch({
      decision: DECISION,
      events: [{ type: "complete" }, { type: "abandon" }],
    });
    if (!("events" in parsed)) throw new Error("expected events");
    await recordVideoEvents(sb as never, parsed);
    expect(sb.updates[0]).toMatchObject({ outcome: "completed" });
  });
});
