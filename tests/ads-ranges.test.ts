import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANGE,
  RANGES,
  bucketAxis,
  bucketOf,
  formatBucket,
  rangeSince,
  resolveRange,
  type RangeId,
} from "@/lib/ads/ranges";

// The range picker drives every number on the dashboard, so the axis it builds
// has to line up exactly with the buckets Postgres emits. SQL uses
// date_bin(step, ts, 'epoch') — an epoch-aligned grid — and if the JS axis were
// aligned to "now" instead, every point would miss its slot by the offset
// between now and the epoch and the chart would render all zeros.

const NOW = new Date("2026-07-31T12:34:56.000Z");
const byId = (id: RangeId) => RANGES.find((r) => r.id === id)!;

describe("resolveRange", () => {
  it("accepts every declared id", () => {
    for (const r of RANGES) expect(resolveRange(r.id).id).toBe(r.id);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveRange("  1H  ").id).toBe("1h");
    expect(resolveRange("ALL").id).toBe("all");
  });

  it("falls back to the default for junk rather than throwing", () => {
    // ?range= is user-controlled, so a bad value must render the dashboard.
    expect(resolveRange("../../etc/passwd").id).toBe(DEFAULT_RANGE);
    expect(resolveRange("").id).toBe(DEFAULT_RANGE);
    expect(resolveRange(undefined).id).toBe(DEFAULT_RANGE);
  });

  it("takes the first value when the param repeats", () => {
    expect(resolveRange(["4h", "1y"]).id).toBe("4h");
  });
});

describe("rangeSince", () => {
  it("is null for all time, so the RPC scans everything", () => {
    expect(rangeSince(byId("all"), NOW)).toBeNull();
  });

  it("subtracts the window from now", () => {
    expect(rangeSince(byId("1h"), NOW)).toBe("2026-07-31T11:34:56.000Z");
    expect(rangeSince(byId("1d"), NOW)).toBe("2026-07-30T12:34:56.000Z");
  });
});

describe("bucketAxis", () => {
  it("aligns buckets to the epoch, not to now", () => {
    // 12:34:56 with 1-minute buckets must land on :34:00, matching date_bin.
    const axis = bucketAxis(byId("1h"), NOW);
    const last = new Date(axis.at(-1)!);
    expect(last.toISOString()).toBe("2026-07-31T12:34:00.000Z");
  });

  it("aligns coarser buckets to the epoch grid too", () => {
    // 5-minute buckets → :30, not :34.
    const axis = bucketAxis(byId("4h"), NOW);
    expect(new Date(axis.at(-1)!).toISOString()).toBe("2026-07-31T12:30:00.000Z");
  });

  it("is sorted oldest first with no gaps", () => {
    for (const r of RANGES) {
      if (r.windowSeconds == null) continue;
      const axis = bucketAxis(r, NOW);
      const step = r.bucketSeconds * 1000;
      for (let i = 1; i < axis.length; i++) expect(axis[i] - axis[i - 1]).toBe(step);
    }
  });

  it("covers the whole window for every range", () => {
    for (const r of RANGES) {
      if (r.windowSeconds == null) continue;
      const axis = bucketAxis(r, NOW);
      const span = axis.at(-1)! - axis[0];
      expect(span).toBeGreaterThanOrEqual(r.windowSeconds * 1000 - r.bucketSeconds * 1000);
    }
  });

  it("keeps every range in a readable point band", () => {
    // Too few and a line reads as a bar chart; too many and buckets fall under
    // a pixel — and the row count starts approaching PostgREST's 1000 cap.
    for (const r of RANGES) {
      if (r.windowSeconds == null) continue;
      const n = bucketAxis(r, NOW).length;
      expect(n).toBeGreaterThanOrEqual(24);
      expect(n).toBeLessThanOrEqual(100);
    }
  });

  it("gives all-time a single seed bucket to grow from", () => {
    expect(bucketAxis(byId("all"), NOW)).toHaveLength(1);
  });
});

describe("bucketOf", () => {
  it("snaps a timestamp onto the same grid the axis uses", () => {
    const r = byId("1h");
    const axis = bucketAxis(r, NOW);
    // Any instant inside the last bucket must map onto that bucket.
    expect(bucketOf("2026-07-31T12:34:59.999Z", r)).toBe(axis.at(-1));
    expect(bucketOf("2026-07-31T12:34:00.000Z", r)).toBe(axis.at(-1));
  });

  it("puts a timestamp one tick earlier in the previous bucket", () => {
    const r = byId("1h");
    const axis = bucketAxis(r, NOW);
    expect(bucketOf("2026-07-31T12:33:59.999Z", r)).toBe(axis.at(-2));
  });

  it("agrees with the axis for every range", () => {
    for (const r of RANGES) {
      if (r.windowSeconds == null) continue;
      const axis = bucketAxis(r, NOW);
      const set = new Set(axis);
      // A sample inside the window must always find a home in the axis,
      // otherwise its data would be silently dropped from the chart.
      const midpoint = new Date(NOW.getTime() - (r.windowSeconds * 1000) / 2).toISOString();
      expect(set.has(bucketOf(midpoint, r))).toBe(true);
    }
  });
});

describe("formatBucket", () => {
  const t = Date.UTC(2026, 6, 31, 12, 0, 0);

  it("renders something non-empty for every tick style", () => {
    for (const tick of ["time", "datetime", "date", "month"] as const) {
      expect(formatBucket(t, tick).length).toBeGreaterThan(0);
    }
  });

  it("gets coarser as the range widens", () => {
    // A 1Y axis labelled with minutes would be unreadable.
    expect(byId("1h").tick).toBe("time");
    expect(byId("1y").tick).toBe("month");
  });
});

describe("range catalog", () => {
  it("has unique ids and labels", () => {
    expect(new Set(RANGES.map((r) => r.id)).size).toBe(RANGES.length);
    expect(new Set(RANGES.map((r) => r.label)).size).toBe(RANGES.length);
  });

  it("runs shortest to longest", () => {
    const windows = RANGES.map((r) => r.windowSeconds ?? Infinity);
    expect([...windows].sort((a, b) => a - b)).toEqual(windows);
  });

  it("never buckets below the SQL floor of 60s", () => {
    // ad_account_series clamps p_bucket_seconds to >= 60; a smaller value here
    // would make the JS axis finer than the data can ever be.
    for (const r of RANGES) expect(r.bucketSeconds).toBeGreaterThanOrEqual(60);
  });

  it("covers 1H through ALL as asked", () => {
    expect(RANGES.map((r) => r.label)).toEqual([
      "1H",
      "4H",
      "1D",
      "1W",
      "1M",
      "3M",
      "1Y",
      "ALL",
    ]);
  });
});
