import { describe, it, expect } from "vitest";
import {
  buildDailyAxis,
  toSeriesRow,
  utcDayAxis,
  type TrackerSeriesRow,
} from "@/lib/tracker/series";
import {
  computeTrend,
  formatTrend,
  portfolioVerdict,
  type TrendDirection,
} from "@/lib/tracker/trend";

// The portfolio page's whole job is answering "up, down, or sideways?", so the
// arithmetic behind that verdict is what these cover. Everything here is pure —
// no database, no clock (both helpers take an injectable `now`).

const NOW = new Date("2026-08-09T12:00:00Z");

function row(day: string, over: Partial<TrackerSeriesRow> = {}): TrackerSeriesRow {
  return {
    day,
    pageviews: 0,
    interactions: 0,
    ai: 0,
    bots: 0,
    events: 0,
    humans: 0,
    ...over,
  };
}

describe("computeTrend", () => {
  it("calls a clear rise up and a clear fall down", () => {
    expect(computeTrend(150, 100).direction).toBe("up");
    expect(computeTrend(150, 100).changePct).toBeCloseTo(50);
    expect(computeTrend(50, 100).direction).toBe("down");
    expect(computeTrend(50, 100).changePct).toBeCloseTo(-50);
  });

  it("treats movement inside the flat band as sideways", () => {
    // 4% either way is noise, not a trend.
    expect(computeTrend(1040, 1000).direction).toBe("flat");
    expect(computeTrend(960, 1000).direction).toBe("flat");
    // Just outside the band it counts.
    expect(computeTrend(1051, 1000).direction).toBe("up");
    expect(computeTrend(949, 1000).direction).toBe("down");
  });

  it("reports no percentage when there is no baseline", () => {
    const fresh = computeTrend(500, 0);
    expect(fresh.changePct).toBeNull();
    expect(fresh.direction).toBe("up");
    expect(formatTrend(fresh)).toBe("▲ new");
  });

  it("is flat, not up, when both windows are empty", () => {
    const nothing = computeTrend(0, 0);
    expect(nothing.direction).toBe("flat");
    expect(formatTrend(nothing)).toBe("▬ no data");
  });

  it("flags low volume without lying about the direction", () => {
    const noisy = computeTrend(6, 2);
    expect(noisy.lowVolume).toBe(true);
    expect(noisy.direction).toBe("up");

    const solid = computeTrend(600, 200);
    expect(solid.lowVolume).toBe(false);
  });

  it("formats magnitude, not sign, next to the arrow", () => {
    expect(formatTrend(computeTrend(50, 100))).toBe("▼ 50%");
    expect(formatTrend(computeTrend(1124, 1000))).toBe("▲ 12.4%");
    expect(formatTrend(computeTrend(1020, 1000))).toBe("▬ 2%");
  });
});

describe("portfolioVerdict", () => {
  const directions = (up: number, flat: number, down: number): TrendDirection[] => [
    ...Array<TrendDirection>(up).fill("up"),
    ...Array<TrendDirection>(flat).fill("flat"),
    ...Array<TrendDirection>(down).fill("down"),
  ];

  it("says growing when the aggregate is up, and shows the split", () => {
    const verdict = portfolioVerdict(computeTrend(1500, 1000), directions(3, 1, 1));
    expect(verdict).toContain("growing");
    expect(verdict).toContain("3 up · 1 sideways · 1 down");
    expect(verdict).toContain("5 properties");
  });

  it("says shrinking when the aggregate is down", () => {
    expect(portfolioVerdict(computeTrend(500, 1000), directions(0, 0, 2))).toContain(
      "shrinking",
    );
  });

  it("says holding steady inside the flat band", () => {
    expect(portfolioVerdict(computeTrend(1020, 1000), directions(1, 2, 1))).toContain(
      "holding steady",
    );
  });

  it("handles a single property and no properties at all", () => {
    expect(portfolioVerdict(computeTrend(10, 5), directions(1, 0, 0))).toContain(
      "1 property.",
    );
    expect(portfolioVerdict(computeTrend(0, 0), [])).toBe(
      "No traffic recorded yet across your properties.",
    );
  });
});

describe("utcDayAxis", () => {
  it("returns `days` UTC days ending today, oldest first", () => {
    const axis = utcDayAxis(7, NOW);
    expect(axis).toHaveLength(7);
    expect(axis[0]).toBe("2026-08-03");
    expect(axis[6]).toBe("2026-08-09");
  });

  it("spans month boundaries", () => {
    expect(utcDayAxis(30, NOW)[0]).toBe("2026-07-11");
  });
});

describe("buildDailyAxis", () => {
  it("zero-fills days with no rows so gaps render flat", () => {
    const daily = buildDailyAxis([row("2026-08-09", { events: 5, pageviews: 5 })], 3, NOW);
    expect(daily.map((p) => p.date)).toEqual([
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
    ]);
    expect(daily.map((p) => p.events)).toEqual([0, 0, 5]);
  });

  it("ignores rows outside the window instead of stretching the axis", () => {
    const daily = buildDailyAxis(
      [row("2026-01-01", { events: 999 }), row("2026-08-08", { events: 4 })],
      3,
      NOW,
    );
    expect(daily).toHaveLength(3);
    expect(daily.reduce((sum, p) => sum + p.events, 0)).toBe(4);
  });

  it("sums multiple rows landing on the same day", () => {
    const daily = buildDailyAxis(
      [
        row("2026-08-09", { events: 3, ai: 1 }),
        row("2026-08-09", { events: 7, ai: 2 }),
      ],
      2,
      NOW,
    );
    const today = daily[daily.length - 1];
    expect(today.events).toBe(10);
    expect(today.ai).toBe(3);
  });

  it("falls back to pageviews + interactions when bucket totals are missing", () => {
    // Older rollups predate the bucket table, so `events` arrives as 0 on a day
    // that plainly had traffic.
    const daily = buildDailyAxis(
      [row("2026-08-09", { pageviews: 8, interactions: 2, events: 0 })],
      1,
      NOW,
    );
    expect(daily[0].events).toBe(10);
  });

  it("sums humans per day and never backfills them from bot-inclusive totals", () => {
    const daily = buildDailyAxis(
      [
        // A crawled day: 3 people, 997 bot hits.
        row("2026-08-09", { events: 1000, bots: 997, humans: 3 }),
        row("2026-08-09", { events: 10, bots: 0, humans: 10 }),
        // A pre-bucket day: the event table knows 40 hits, nobody knows how
        // many were people. events gets the legacy backfill; humans stays 0.
        row("2026-08-08", { pageviews: 30, interactions: 10, events: 0 }),
      ],
      2,
      NOW,
    );
    const [older, today] = daily;
    expect(today.humans).toBe(13);
    expect(today.bots).toBe(997);
    expect(today.events).toBe(1010);
    expect(older.events).toBe(40);
    expect(older.humans).toBe(0);
  });
});

describe("toSeriesRow", () => {
  it("coerces the bigint columns PostgREST hands back as strings", () => {
    const coerced = toSeriesRow({
      day: "2026-08-09",
      pageviews: "12",
      interactions: "3",
      ai: "4",
      bots: "5",
      events: "20",
      humans: "15",
    });
    expect(coerced).toEqual({
      day: "2026-08-09",
      pageviews: 12,
      interactions: 3,
      ai: 4,
      bots: 5,
      events: 20,
      humans: 15,
    });
  });

  it("derives humans = events - bots when the RPC predates the split", () => {
    // Before 20260905120000_tracker_human_split is applied the column is
    // absent. Both legs come from the bucket rollup, so the identity is exact.
    const coerced = toSeriesRow({
      day: "2026-08-09",
      pageviews: "12",
      interactions: "3",
      ai: "4",
      bots: "5",
      events: "20",
    });
    expect(coerced.humans).toBe(15);
  });
});
