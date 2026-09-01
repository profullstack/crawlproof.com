import { describe, expect, it } from "vitest";
import {
  getCampaignTotalsSince,
  getSlotTotalsSince,
  sinceForDays,
  deliveredClicks,
  deliveredImpressions,
  EMPTY_SLOT_TOTALS,
} from "@/lib/ads/series";

// The earnings page and the slots page read `impressions` and `clicks` off
// ad_slot_stats / ad_campaign_stats, which are the tier-'paid' halves of those
// views — the free halves sit in separate columns neither page selected. Once
// every fill on the network became a self-deal, both pages read zero for months
// while the campaigns dashboard, which sums both halves, showed six figures:
// rssamplifier.com delivered 116,071 impressions and the page said 0.
//
// The same views are also lifetime, with no window, while the page and the PDF
// header both promise "last N days".

const NOW = new Date("2026-09-01T14:26:00.000Z");

const clientReturning = (rows: unknown[]): any => ({
  rpc: async () => ({ data: rows, error: null }),
});
const failingClient = (): any => ({
  rpc: async () => ({ data: null, error: { message: "boom" } }),
});

describe("getSlotTotalsSince", () => {
  it("keeps free-tier delivery the paid column alone would hide", async () => {
    const totals = await getSlotTotalsSince(
      clientReturning([
        {
          slot_id: "slot-rss",
          impressions: 0,
          free_impressions: 116071,
          clicks: 0,
          free_clicks: 4618,
          invalid_clicks: 0,
          earned_cents: 0,
        },
      ]),
      null,
    );

    const s = totals.get("slot-rss")!;
    expect(s.impressions).toBe(0); // nothing was billable...
    expect(deliveredImpressions(s)).toBe(116071); // ...but the site showed them
    expect(deliveredClicks(s)).toBe(4618);
  });

  it("reports invalid clicks separately instead of as delivery", async () => {
    // Folding bot clicks into the free bucket to make them visible would put a
    // 16% CTR on the page. They are counted, and counted apart.
    const totals = await getSlotTotalsSince(
      clientReturning([
        {
          slot_id: "s1",
          impressions: 0,
          free_impressions: 1000,
          clicks: 0,
          free_clicks: 10,
          invalid_clicks: 57060,
          earned_cents: 0,
        },
      ]),
      null,
    );

    const s = totals.get("s1")!;
    expect(s.invalidClicks).toBe(57060);
    expect(deliveredClicks(s)).toBe(10);
  });

  it("coerces the bigint-as-string counts PostgREST returns", async () => {
    const totals = await getSlotTotalsSince(
      clientReturning([
        {
          slot_id: "s1",
          impressions: "3",
          free_impressions: "4",
          clicks: "1",
          free_clicks: "2",
          invalid_clicks: "5",
          earned_cents: "263",
        },
      ]),
      null,
    );

    expect(totals.get("s1")).toEqual({
      impressions: 3,
      freeImpressions: 4,
      clicks: 1,
      freeClicks: 2,
      invalidClicks: 5,
      earnedCents: 263,
    });
  });

  it("returns an empty map rather than throwing when the RPC fails", async () => {
    const totals = await getSlotTotalsSince(failingClient(), null);
    expect(totals.size).toBe(0);
    // Callers fall back to the zero row, so a failed RPC renders a quiet page
    // rather than a 500.
    expect(totals.get("missing") ?? EMPTY_SLOT_TOTALS).toEqual(EMPTY_SLOT_TOTALS);
  });
});

describe("getCampaignTotalsSince", () => {
  it("counts both tiers, so an all-free campaign is not a dead row", async () => {
    const totals = await getCampaignTotalsSince(
      clientReturning([
        {
          campaign_id: "c1",
          impressions: 0,
          free_impressions: 2269,
          clicks: 0,
          free_clicks: 76,
          spent_cents: 0,
        },
      ]),
      sinceForDays(30, NOW),
    );

    const c = totals.get("c1")!;
    expect(deliveredImpressions(c)).toBe(2269);
    expect(deliveredClicks(c)).toBe(76);
    expect(c.spentCents).toBe(0);
  });
});

describe("sinceForDays", () => {
  it("opens the window at the start of a UTC day, matching the chart axis", () => {
    // dayAxis() and ad_campaign_daily_series both work in whole UTC days, so a
    // table total that started mid-day would disagree with the chart above it.
    expect(sinceForDays(30, NOW)).toBe("2026-08-03T00:00:00.000Z");
  });

  it("counts today as the first of the N days, not an extra one", () => {
    expect(sinceForDays(1, NOW)).toBe("2026-09-01T00:00:00.000Z");
    expect(sinceForDays(2, NOW)).toBe("2026-08-31T00:00:00.000Z");
  });

  it("never yields an empty or backwards window", () => {
    expect(sinceForDays(0, NOW)).toBe("2026-09-01T00:00:00.000Z");
    expect(sinceForDays(-5, NOW)).toBe("2026-09-01T00:00:00.000Z");
  });
});
