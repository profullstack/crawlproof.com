import { describe, expect, it } from "vitest";
import { getCampaignDailySeries } from "@/lib/ads/series";

// ad_campaign_daily_series used to return one row per campaign-day. At 139
// campaigns over 30 days that is 2,731 rows, and PostgREST caps a response at
// 1,000: the call came back `206 Partial Content, content-range 0-999/2731`.
// The function has no ORDER BY, so which two thirds survived was down to the
// join order — campaigns lost days off the end of their sparkline and five lost
// every row, rendering "no traffic yet" next to a row reading "Impressions: 24".
//
// It returns a single jsonb array now, which is one row whatever the campaign
// count. These tests pin the parsing of that shape, because the wire format is
// the only thing that changed and every ad surface reads this loader.

const CAMPAIGNS = ["c1", "c2"];

/** Minimal stand-in: getCampaignDailySeries only calls .rpc. */
const clientReturning = (data: unknown): any => ({
  rpc: async () => ({ data, error: null }),
});
const failingClient = (): any => ({
  rpc: async () => ({ data: null, error: { message: "boom" } }),
});

const today = () => new Date().toISOString().slice(0, 10);

describe("getCampaignDailySeries over the jsonb payload", () => {
  it("reads a jsonb array straight through, no envelope to unwrap", async () => {
    const { data, failed } = await getCampaignDailySeries(
      clientReturning([
        { campaign_id: "c1", day: today(), impressions: 24, clicks: 2, spent_cents: 0 },
      ]),
      CAMPAIGNS,
      7,
    );

    expect(failed).toBe(false);
    const point = data.get("c1")!.find((p) => p.date === today())!;
    expect(point.impressions).toBe(24);
    expect(point.clicks).toBe(2);
  });

  it("keeps every campaign's axis zero-filled, including ones with no rows", async () => {
    const { data } = await getCampaignDailySeries(
      clientReturning([
        { campaign_id: "c1", day: today(), impressions: 5, clicks: 0, spent_cents: 0 },
      ]),
      CAMPAIGNS,
      7,
    );

    // c2 sent nothing back. It still gets a full axis of zeros rather than
    // being absent, so the row renders a flat sparkline instead of throwing.
    expect(data.get("c2")).toHaveLength(7);
    expect(data.get("c2")!.every((p) => p.impressions === 0)).toBe(true);
    expect(data.get("c1")).toHaveLength(7);
  });

  it("takes bigint counts that arrived as JSON strings", async () => {
    // jsonb renders bigint as a number, but a driver or a proxy that widens it
    // to a string must not silently zero the sparkline.
    const { data } = await getCampaignDailySeries(
      clientReturning([
        { campaign_id: "c1", day: today(), impressions: "48", clicks: "3", spent_cents: "150" },
      ]),
      CAMPAIGNS,
      7,
    );

    const point = data.get("c1")!.find((p) => p.date === today())!;
    expect(point.impressions).toBe(48);
    expect(point.clicks).toBe(3);
    expect(point.spentCents).toBe(150);
  });

  it("ignores days outside the requested window instead of misfiling them", async () => {
    const { data } = await getCampaignDailySeries(
      clientReturning([
        { campaign_id: "c1", day: "2020-01-01", impressions: 999, clicks: 9, spent_cents: 0 },
      ]),
      CAMPAIGNS,
      7,
    );

    expect(data.get("c1")!.every((p) => p.impressions === 0)).toBe(true);
  });

  it("treats an empty array as a quiet window, not a failure", async () => {
    const { data, failed } = await getCampaignDailySeries(clientReturning([]), CAMPAIGNS, 7);
    expect(failed).toBe(false);
    expect(data.get("c1")!.every((p) => p.impressions === 0)).toBe(true);
  });

  it("flags a failed call, so a zero-filled axis is never read as real", async () => {
    const { data, failed } = await getCampaignDailySeries(failingClient(), CAMPAIGNS, 7);
    // The zero-fill stays — one dead panel should not take the page down — but
    // `failed` is what lets MiniTrend say "unavailable" instead of asserting
    // "no traffic yet" about a campaign it never managed to read.
    expect(failed).toBe(true);
    expect(data.get("c1")).toHaveLength(7);
  });

  it("does not call out at all when there are no campaigns", async () => {
    const { data, failed } = await getCampaignDailySeries(failingClient(), [], 7);
    expect(failed).toBe(false);
    expect(data.size).toBe(0);
  });
});
