import { describe, expect, it } from "vitest";
import {
  deliveredClicks,
  deliveredImpressions,
  deliverySplitNote,
  getAccountSeries,
  pickDeliveredClicks,
  pickDeliveredImpressions,
  sumSeries,
  EMPTY_TOTALS,
} from "@/lib/ads/series";
import { RANGES, bucketAxis, bucketOf, rangeSince, type RangeId } from "@/lib/ads/ranges";

// The stats box above the delivery chart went blank for 1W and every shorter
// range while the chart under it drew thousands of impressions. Nothing was
// failing to load: the tiles counted paid delivery only, and once every slot
// and every campaign belonged to one account, serveAd demoted every fill to the
// free tier as a self-deal. 1M and wider still reached back to genuinely paid
// days, which is exactly why the break looked like a short-range bug.

const NOW = new Date("2026-08-18T09:50:00.000Z");
const byId = (id: RangeId) => RANGES.find((r) => r.id === id)!;

/** Minimal stand-in for the Supabase client: getAccountSeries only calls .rpc. */
const clientReturning = (rows: unknown[]): any => ({
  rpc: async () => ({ data: rows, error: null }),
});
const failingClient = (): any => ({
  rpc: async () => ({ data: null, error: { message: "boom" } }),
});

const row = (bucket: string, over: Record<string, number> = {}) => ({
  bucket,
  impressions: 0,
  free_impressions: 0,
  clicks: 0,
  free_clicks: 0,
  spent_cents: 0,
  ...over,
});

describe("delivered totals", () => {
  it("counts free backfill as delivery, because it was delivered", () => {
    const totals = { ...EMPTY_TOTALS, impressions: 0, freeImpressions: 16207 };
    expect(deliveredImpressions(totals)).toBe(16207);
  });

  it("counts an unbillable click as a click", () => {
    const totals = { ...EMPTY_TOTALS, clicks: 0, freeClicks: 649 };
    expect(deliveredClicks(totals)).toBe(649);
  });

  it("adds the two tiers rather than preferring one", () => {
    const totals = { ...EMPTY_TOTALS, impressions: 12, freeImpressions: 30, clicks: 2, freeClicks: 5 };
    expect(deliveredImpressions(totals)).toBe(42);
    expect(deliveredClicks(totals)).toBe(7);
  });

  it("gives the sparklines the same measure as the number above them", () => {
    const p = { t: 0, impressions: 3, freeImpressions: 4, clicks: 1, freeClicks: 2, spentCents: 9 };
    expect(pickDeliveredImpressions(p)).toBe(7);
    expect(pickDeliveredClicks(p)).toBe(3);
  });
});

describe("delivery split note", () => {
  it("says nothing when there is no free tier to explain", () => {
    expect(deliverySplitNote(500, 0)).toBeUndefined();
    expect(deliverySplitNote(0, 0)).toBeUndefined();
  });

  it("names the all-free case outright, so a $0 spend reads as intended", () => {
    expect(deliverySplitNote(0, 16207)).toBe("all free backfill");
  });

  it("gives both halves when delivery is mixed", () => {
    expect(deliverySplitNote(1200, 300)).toBe("1,200 paid · 300 free");
  });
});

describe("getAccountSeries", () => {
  it("keeps free-tier delivery that the paid figure alone would hide", async () => {
    const range = byId("1w");
    const axis = bucketAxis(range, NOW);
    const rows = [row(new Date(axis.at(-1)!).toISOString(), { free_impressions: 240, free_clicks: 3 })];

    const { data: points } = await getAccountSeries(clientReturning(rows), range, NOW);
    const totals = sumSeries(points);

    expect(totals.impressions).toBe(0); // nothing was billable...
    expect(deliveredImpressions(totals)).toBe(240); // ...but 240 ads were shown
    expect(deliveredClicks(totals)).toBe(3);
  });

  it("keeps the partial bucket at the start of the window", async () => {
    // The window opens mid-bucket for every range coarser than a minute, so the
    // RPC emits a leading bucket that starts before `since`. The axis used to
    // stop one bucket short and getAccountSeries dropped the row on the floor —
    // silently, since an unmatched bucket is skipped rather than appended.
    for (const range of RANGES) {
      if (range.windowSeconds == null) continue;
      const since = rangeSince(range, NOW)!;
      const rows = [row(new Date(bucketOf(since, range)).toISOString(), { impressions: 7 })];

      const { data: points } = await getAccountSeries(clientReturning(rows), range, NOW);
      expect(sumSeries(points).impressions, `${range.id} dropped its first bucket`).toBe(7);
    }
  });

  it("still covers the whole window without duplicating a bucket", () => {
    for (const range of RANGES) {
      if (range.windowSeconds == null) continue;
      const axis = bucketAxis(range, NOW);
      expect(new Set(axis).size).toBe(axis.length);
      expect(axis[0]).toBeLessThanOrEqual(NOW.getTime() - range.windowSeconds * 1000);
      // One partial bucket of slack at each end, no more.
      expect(axis[0]).toBeGreaterThan(
        NOW.getTime() - (range.windowSeconds + range.bucketSeconds) * 1000,
      );
    }
  });

  it("zero-fills the whole axis so a quiet range still draws a line", async () => {
    const range = byId("1d");
    const { data: points, failed } = await getAccountSeries(clientReturning([]), range, NOW);
    expect(points).toHaveLength(bucketAxis(range, NOW).length);
    expect(sumSeries(points)).toEqual(EMPTY_TOTALS);
    // A genuinely quiet range is not a failure, and must not raise the banner.
    expect(failed).toBe(false);
  });

  it("renders an empty range rather than throwing when the RPC fails", async () => {
    const { data: points } = await getAccountSeries(failingClient(), byId("1h"), NOW);
    expect(sumSeries(points)).toEqual(EMPTY_TOTALS);
  });

  it("says it failed, so the zeros are not reported as real delivery", async () => {
    // The whole point: a cancelled query and a quiet range both sum to zero.
    // Without this flag the dashboard presented the first as the second, which
    // is how a network delivering 176k impressions showed four zeros and read
    // as a dead pipeline.
    const failing = await getAccountSeries(failingClient(), byId("1h"), NOW);
    const quiet = await getAccountSeries(clientReturning([]), byId("1h"), NOW);

    expect(sumSeries(failing.data)).toEqual(sumSeries(quiet.data));
    expect(failing.failed).toBe(true);
    expect(quiet.failed).toBe(false);
  });
});
