import { describe, expect, it } from "vitest";
import {
  campaignDisplayStatus,
  campaignTier,
  isDailyBudgetReached,
  spendTodayCents,
  utcToday,
  type CampaignBudgetFields,
} from "@/lib/ads/status";
import { CREDIT_CENTS, DEFAULT_BID_CREDITS } from "@/lib/ads/pricing";

// A campaign must never go dark for want of money — running out of credits or
// hitting the daily cap drops it to the free tier, where it backfills unsold
// inventory at no cost to anyone. These cases pin down that it keeps serving,
// that it returns to paid delivery on its own, and that the dashboard says
// which of the two reasons put it there.

const TODAY = "2026-07-30";

const campaign = (over: Partial<CampaignBudgetFields> = {}): CampaignBudgetFields => ({
  status: "active",
  daily_budget_cents: 500,
  spend_today_cents: 0,
  spend_date: TODAY,
  bid_credits: DEFAULT_BID_CREDITS,
  ...over,
});

describe("spendTodayCents", () => {
  it("counts spend recorded today", () => {
    expect(spendTodayCents(campaign({ spend_today_cents: 320 }), TODAY)).toBe(320);
  });

  it("ignores a stale counter from an earlier UTC day", () => {
    // ad_charge_click/serveAd both reset lazily, so the stored column still
    // holds yesterday's total until the next click lands.
    expect(
      spendTodayCents(campaign({ spend_today_cents: 500, spend_date: "2026-07-29" }), TODAY),
    ).toBe(0);
  });

  it("treats a never-spent campaign as zero", () => {
    expect(spendTodayCents(campaign({ spend_today_cents: null, spend_date: null }), TODAY)).toBe(0);
  });
});

describe("isDailyBudgetReached", () => {
  it("is false while one more click still fits under the cap", () => {
    // 500c cap, 480c spent, 4-credit bid = 20c → exactly fits.
    expect(isDailyBudgetReached(campaign({ spend_today_cents: 480 }), TODAY)).toBe(false);
  });

  it("is true once the next click would exceed the cap", () => {
    expect(isDailyBudgetReached(campaign({ spend_today_cents: 481 }), TODAY)).toBe(true);
  });

  it("trips sooner for a higher bid", () => {
    const c = campaign({ spend_today_cents: 400, bid_credits: 40 }); // 40 × 5c = 200c
    expect(isDailyBudgetReached(c, TODAY)).toBe(true);
  });

  it("falls back to the default bid when the column is missing", () => {
    const c = campaign({ spend_today_cents: 500 - DEFAULT_BID_CREDITS * CREDIT_CENTS, bid_credits: null });
    expect(isDailyBudgetReached(c, TODAY)).toBe(false);
  });

  it("clears on the next UTC day even with a maxed-out stale counter", () => {
    const c = campaign({ spend_today_cents: 500, spend_date: "2026-07-29" });
    expect(isDailyBudgetReached(c, TODAY)).toBe(false);
  });
});

describe("campaignTier", () => {
  it("puts a funded, in-budget campaign on the paid tier", () => {
    expect(campaignTier(campaign(), TODAY, 100)).toBe("paid");
  });

  it("drops a campaign that can't cover one click to the free tier", () => {
    expect(campaignTier(campaign(), TODAY, DEFAULT_BID_CREDITS - 1)).toBe("free");
  });

  it("keeps a campaign paid when it can cover exactly one more click", () => {
    expect(campaignTier(campaign(), TODAY, DEFAULT_BID_CREDITS)).toBe("paid");
  });

  it("drops a campaign over its daily cap to the free tier", () => {
    expect(campaignTier(campaign({ spend_today_cents: 500 }), TODAY, 1000)).toBe("free");
  });

  it("treats the legacy exhausted status as free tier, not dark", () => {
    // Rows written before the free tier existed must not stay dark forever.
    expect(campaignTier(campaign({ status: "exhausted" }), TODAY, 1000)).toBe("free");
  });

  it("serves nothing for paused and draft", () => {
    expect(campaignTier(campaign({ status: "paused" }), TODAY, 1000)).toBe("none");
    expect(campaignTier(campaign({ status: "draft" }), TODAY, 1000)).toBe("none");
  });

  it("assumes paid when the balance wasn't looked up", () => {
    // A caller without the balance to hand must not paint a funded campaign
    // as broke; ad_charge_click still refuses to bill what isn't there.
    expect(campaignTier(campaign(), TODAY, undefined)).toBe("paid");
    expect(campaignTier(campaign(), TODAY, null)).toBe("paid");
  });
});

describe("campaignDisplayStatus", () => {
  it("reports a live campaign as active and serving", () => {
    const d = campaignDisplayStatus(campaign(), TODAY, 1000);
    expect(d.label).toBe("active");
    expect(d.serving).toBe(true);
    expect(d.tier).toBe("paid");
  });

  it("keeps a capped campaign serving on the free tier", () => {
    const d = campaignDisplayStatus(campaign({ spend_today_cents: 500 }), TODAY, 1000);
    expect(d.label).toBe("free tier");
    expect(d.serving).toBe(true); // still rendering, as backfill
    expect(d.resumesAutomatically).toBe(true);
    expect(d.hint).toMatch(/00:00 UTC/);
  });

  it("keeps a broke campaign serving instead of deactivating it", () => {
    // The whole point: running dry must never take a campaign dark, and must
    // never require the advertiser to press Activate again.
    const d = campaignDisplayStatus(campaign(), TODAY, 0);
    expect(d.label).toBe("free tier");
    expect(d.serving).toBe(true);
    expect(d.resumesAutomatically).toBe(true);
    expect(d.hint).toMatch(/Top up/);
    expect(d.hint).not.toMatch(/Activate/);
  });

  it("revives a legacy exhausted campaign", () => {
    const d = campaignDisplayStatus(campaign({ status: "exhausted" }), TODAY, 1000);
    expect(d.serving).toBe(true);
    expect(d.tier).toBe("free");
    expect(d.resumesAutomatically).toBe(true);
  });

  it("blames the empty wallet before the daily cap", () => {
    // Both true at once — the advertiser needs the actionable one.
    const d = campaignDisplayStatus(campaign({ spend_today_cents: 500 }), TODAY, 0);
    expect(d.hint).toMatch(/Top up/);
  });

  it("passes through paused and draft", () => {
    expect(campaignDisplayStatus(campaign({ status: "paused" }), TODAY, 1000).label).toBe("paused");
    expect(campaignDisplayStatus(campaign({ status: "draft" }), TODAY, 1000).label).toBe("draft");
  });

  it("does not report free tier for a campaign that isn't live", () => {
    const d = campaignDisplayStatus(campaign({ status: "paused", spend_today_cents: 500 }), TODAY, 0);
    expect(d.label).toBe("paused");
    expect(d.serving).toBe(false);
    expect(d.resumesAutomatically).toBe(false);
  });
});

describe("utcToday", () => {
  it("uses the UTC calendar day, matching SQL current_date", () => {
    // 23:30 UTC-adjacent local times must not roll the day forward/back.
    expect(utcToday(new Date("2026-07-30T23:30:00Z"))).toBe("2026-07-30");
    expect(utcToday(new Date("2026-07-31T00:10:00Z"))).toBe("2026-07-31");
  });
});
