import { describe, expect, it } from "vitest";

import { mapLimit, mergeLists } from "@/lib/dashboard/collect";
import { parseDays } from "@/app/api/ads/v1/earnings/route";

describe("mapLimit", () => {
  it("keeps results in input order however they finish", async () => {
    const out = await mapLimit([30, 10, 20, 0], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20, 0]);
  });

  it("never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("handles an empty list without hanging", async () => {
    expect(await mapLimit([], 8, async () => 1)).toEqual([]);
  });
});

describe("mergeLists", () => {
  it("sums a label across sites and orders by size", () => {
    const merged = mergeLists([
      [
        { label: "Search · google", value: 10 },
        { label: "Social · reddit", value: 3 },
      ],
      [{ label: "Search · google", value: 5 }],
    ]);
    expect(merged[0]).toEqual({ label: "Search · google", value: 15 });
    expect(merged[1]).toEqual({ label: "Social · reddit", value: 3 });
  });

  it("drops blank labels and survives a missing list", () => {
    const merged = mergeLists([
      [{ label: "", value: 9 }],
      undefined as unknown as { label: string; value: number }[],
      [{ label: "ok", value: 1 }],
    ]);
    expect(merged).toEqual([{ label: "ok", value: 1 }]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ label: `s${i}`, value: i }));
    expect(mergeLists([many], 5)).toHaveLength(5);
  });
});

describe("earnings route window", () => {
  it("accepts the windows the dashboard offers", () => {
    expect(parseDays("7")).toBe(7);
    expect(parseDays("365")).toBe(365);
  });

  it("falls back to 30 rather than passing anything else to the query", () => {
    expect(parseDays(null)).toBe(30);
    expect(parseDays("31")).toBe(30);
    expect(parseDays("; drop table")).toBe(30);
  });
});
