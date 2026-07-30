import { describe, expect, it } from "vitest";
import {
  campaignDisplayStatus,
  isDailyBudgetReached,
  spendTodayCents,
  utcToday,
  type CampaignBudgetFields,
} from "@/lib/ads/status";
import { CREDIT_CENTS, DEFAULT_BID_CREDITS } from "@/lib/ads/pricing";

// The two ways a campaign stops serving look identical in the raw status
// column, so these cases pin down which one the dashboard reports — and, more
// importantly, whether it tells the advertiser to wait or to take action.

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

describe("campaignDisplayStatus", () => {
  it("reports a live campaign as active and serving", () => {
    const d = campaignDisplayStatus(campaign(), TODAY);
    expect(d.label).toBe("active");
    expect(d.serving).toBe(true);
  });

  it("distinguishes the daily cap as a self-healing pause", () => {
    const d = campaignDisplayStatus(campaign({ spend_today_cents: 500 }), TODAY);
    expect(d.label).toBe("daily budget reached");
    expect(d.serving).toBe(false);
    expect(d.resumesAutomatically).toBe(true);
    expect(d.hint).toMatch(/00:00 UTC/);
  });

  it("reports exhausted credits as needing manual action", () => {
    const d = campaignDisplayStatus(campaign({ status: "exhausted" }), TODAY);
    expect(d.label).toBe("out of credits");
    expect(d.serving).toBe(false);
    expect(d.resumesAutomatically).toBe(false);
    expect(d.hint).toMatch(/Activate/);
  });

  it("keeps exhausted distinct from the daily cap even when under budget", () => {
    // Plenty of budget left — the stop is the empty wallet, not the cap.
    const d = campaignDisplayStatus(campaign({ status: "exhausted", spend_today_cents: 0 }), TODAY);
    expect(d.label).toBe("out of credits");
  });

  it("passes through paused and draft", () => {
    expect(campaignDisplayStatus(campaign({ status: "paused" }), TODAY).label).toBe("paused");
    expect(campaignDisplayStatus(campaign({ status: "draft" }), TODAY).label).toBe("draft");
  });

  it("does not report a budget pause for a campaign that isn't live", () => {
    const d = campaignDisplayStatus(campaign({ status: "paused", spend_today_cents: 500 }), TODAY);
    expect(d.label).toBe("paused");
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
