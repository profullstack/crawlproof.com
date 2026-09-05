import { describe, expect, it } from "vitest";
import { humansFrom, toCount } from "@/lib/tracker/humans";
import {
  emptyTotals,
  sumTotals,
  toProjectTotals,
  totalsTrends,
  type TotalsRow,
} from "@/lib/tracker/totals";
import { buildBucketAxis } from "@/lib/tracker/panels";

// The dashboards lead with human visits and show bot crawls apart. On one
// property 99% of ~257k weekly hits were one AI training crawler, and the
// old bot-inclusive headline read as "80k pageviews a day". These pin the
// arithmetic that keeps the two figures separate, including the period
// before the split migration is applied (no `humans` column yet).

const NOW = new Date("2026-09-05T12:00:00Z");

function totalsRow(over: Partial<TotalsRow> = {}): TotalsRow {
  return {
    project_id: "p1",
    events: 0,
    ai: 0,
    bots: 0,
    prev_events: 0,
    prev_ai: 0,
    prev_bots: 0,
    ...over,
  };
}

describe("toCount", () => {
  it("coerces PostgREST bigint strings and treats absent as null, not zero", () => {
    expect(toCount("257000")).toBe(257000);
    expect(toCount(12)).toBe(12);
    expect(toCount(null)).toBeNull();
    expect(toCount(undefined)).toBeNull();
    expect(toCount("")).toBeNull();
    expect(toCount("nope")).toBeNull();
  });
});

describe("humansFrom", () => {
  it("prefers the humans column the split migration adds", () => {
    expect(humansFrom({ humans: "3", events: "1000", bots: "997" })).toBe(3);
    // Trusted even when it disagrees with the identity (e.g. 0 on purpose).
    expect(humansFrom({ humans: 0, events: 50, bots: 10 })).toBe(0);
  });

  it("falls back to events - bots when the column is missing", () => {
    expect(humansFrom({ events: "1000", bots: "997" })).toBe(3);
    expect(humansFrom({ humans: null, events: 20, bots: 5 })).toBe(15);
  });

  it("never goes negative on a malformed row", () => {
    expect(humansFrom({ events: 5, bots: 9 })).toBe(0);
  });
});

describe("toProjectTotals", () => {
  it("reads humans and prev_humans when present", () => {
    const totals = toProjectTotals(
      totalsRow({
        events: "257000",
        ai: "40",
        bots: "254430",
        humans: "2570",
        prev_events: "180000",
        prev_ai: "30",
        prev_bots: "177600",
        prev_humans: "2400",
      }),
    );
    expect(totals.humans).toBe(2570);
    expect(totals.prevHumans).toBe(2400);
    expect(totals.bots).toBe(254430);
    expect(totals.events).toBe(257000);
  });

  it("derives both human figures before the migration lands", () => {
    const totals = toProjectTotals(
      totalsRow({
        events: 1000,
        bots: 997,
        prev_events: 800,
        prev_bots: 700,
      }),
    );
    expect(totals.humans).toBe(3);
    expect(totals.prevHumans).toBe(100);
  });
});

describe("sumTotals", () => {
  it("adds every field including the human ones", () => {
    const sum = sumTotals([
      { ...emptyTotals(), events: 10, bots: 4, humans: 6, prevHumans: 1 },
      { ...emptyTotals(), events: 20, bots: 5, humans: 15, prevHumans: 2, ai: 3 },
    ]);
    expect(sum).toEqual({
      events: 30,
      ai: 3,
      bots: 9,
      humans: 21,
      prevEvents: 0,
      prevAi: 0,
      prevBots: 0,
      prevHumans: 3,
    });
  });
});

describe("totalsTrends", () => {
  it("trends humans on humans, not on the bot-inclusive total", () => {
    // Humans fell by half while a crawler tripled the raw total.
    const trends = totalsTrends({
      events: 300_000,
      ai: 0,
      bots: 299_500,
      humans: 500,
      prevEvents: 100_000,
      prevAi: 0,
      prevBots: 99_000,
      prevHumans: 1000,
    });
    expect(trends.humans.direction).toBe("down");
    expect(trends.humans.changePct).toBeCloseTo(-50);
    expect(trends.bots.direction).toBe("up");
    expect(trends.events.direction).toBe("up");
  });
});

describe("buildBucketAxis", () => {
  it("carries humans through the sub-day series, derived when absent", () => {
    const points = buildBucketAxis(
      [
        {
          ts: "2026-09-05T11:55:00Z",
          pageviews: "10",
          interactions: "0",
          ai: "1",
          bots: "7",
          events: "10",
          humans: "3",
        },
        {
          ts: "2026-09-05T11:50:00Z",
          pageviews: "4",
          interactions: "0",
          ai: "0",
          bots: "1",
          events: "4",
          // no humans column: pre-migration shape
        },
      ],
      10,
      300,
      NOW,
    );
    const byIso = new Map(points.map((p) => [p.date, p]));
    expect(byIso.get("2026-09-05T11:55:00.000Z")?.humans).toBe(3);
    expect(byIso.get("2026-09-05T11:50:00.000Z")?.humans).toBe(3);
    // Zero-filled buckets carry the field too.
    expect(byIso.get("2026-09-05T12:00:00.000Z")?.humans).toBe(0);
  });
});
