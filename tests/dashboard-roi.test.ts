import { describe, expect, it } from "vitest";

import {
  adTargets,
  businessAccountIds,
  businessBurn,
  buildRoi,
  rangeDays,
  sumTraffic,
  toMonthly,
  vendorSpend,
  type FinanceInput,
  type SiteTraffic,
} from "@/lib/dashboard/roi";

// Shapes copied from live responses, numbers invented: the real ones are one
// person's bank feed and do not belong in a repository.

const finance = (): FinanceInput => ({
  windowDays: 30,
  // Lifetime, and deliberately far above the series below: this is the shape
  // production actually returns, and the gap is what used to be mistaken for
  // a run rate.
  earnings: { commissionUsd: 5_000, grossVolumeUsd: 500_000, netUsd: 495_000 },
  // 30 points summing to 120 commission and 12,000 volume: the real rate.
  series: Array.from({ length: 30 }, (_, i) => ({
    label: `2026-08-${String(i + 1).padStart(2, "0")}`,
    volumeUsd: 400,
    commissionUsd: 4,
  })),
  position: {
    lookbackDays: 180,
    monthsObserved: 4,
    spending: { perMonth: 5000 },
    income: { perMonth: 1000 },
    ratios: { monthsOfCover: 1.5 },
    scopes: [
      { scope: "personal", accounts: 3, spending: 12_000, income: 3_000 },
      { scope: "business", accounts: 2, spending: 8_000, income: 400 },
    ],
  },
  bank: {
    accounts: [
      { id: "biz-1", effective_scope: "business", name: "Business Card" },
      { id: "me-1", effective_scope: "personal", name: "Personal Card" },
    ],
    ledgerTotal: 4,
    ledger: [
      { account_id: "biz-1", payee: "Anthropic", amount: -60, category: "software" },
      { account_id: "biz-1", payee: "Anthropic", amount: -40, category: "software" },
      { account_id: "biz-1", payee: "Railway", amount: -25, category: "software" },
      { account_id: "me-1", payee: "Groceries", amount: -300, category: "food" },
    ],
  },
});

const ads = () => ({
  rangeDays: 30,
  statsUnavailable: false,
  totals: {
    spentCents: 5_000,
    earnedCents: 5_000,
    availableCents: 1_200,
    advImpressions: 900,
    advClicks: 9,
    pubImpressions: 1_000,
    pubClicks: 20,
    invalidClicks: 3,
  },
});

const traffic = (sites: SiteTraffic[] = [{ site: "a.com", visitors: 600, pageviews: 900 }]) => ({
  range: "1m",
  who: "humans",
  sites,
});

describe("window arithmetic", () => {
  it("maps every tracker range onto days, including the sub-day ones", () => {
    expect(rangeDays("1d")).toBe(1);
    expect(rangeDays("1w")).toBe(7);
    expect(rangeDays("1m")).toBe(30);
    expect(rangeDays("4h")).toBeCloseTo(1 / 6);
    expect(rangeDays("nonsense")).toBe(1);
  });

  it("rescales a window total to a monthly rate", () => {
    expect(toMonthly(70, 7)).toBe(300);
    expect(toMonthly(100, 30)).toBe(100);
    expect(toMonthly(100, 0)).toBe(0);
  });
});

describe("traffic", () => {
  it("counts a failed site as not reporting rather than as zero", () => {
    const summed = sumTraffic([
      { site: "a", visitors: 10, pageviews: 20 },
      { site: "b", visitors: 0, pageviews: 0, error: "timeout" },
    ]);
    expect(summed.visitors).toBe(10);
    expect(summed.sites).toBe(2);
    expect(summed.sitesReporting).toBe(1);
  });
});

describe("business scope", () => {
  it("reads business burn as a rate from the scope total and months observed", () => {
    // 8,000 over 4 observed months.
    expect(businessBurn(finance()).perMonthUsd).toBe(2_000);
    expect(businessBurn(finance()).scopeMissing).toBe(false);
  });

  it("falls back to the whole feed, and says so, when nothing is marked business", () => {
    const f = finance();
    f.position!.scopes = [{ scope: "personal", spending: 12_000 }];
    const burn = businessBurn(f);
    expect(burn.perMonthUsd).toBe(5_000);
    expect(burn.scopeMissing).toBe(true);
  });

  it("picks out the business account ids", () => {
    expect([...businessAccountIds(finance())]).toEqual(["biz-1"]);
  });
});

describe("vendors", () => {
  it("groups debits by payee and leaves personal accounts out", () => {
    const vendors = vendorSpend(finance());
    expect(vendors[0]).toEqual({ payee: "Anthropic", usd: 100, charges: 2 });
    expect(vendors[1]).toEqual({ payee: "Railway", usd: 25, charges: 1 });
    expect(vendors.some((v) => v.payee === "Groceries")).toBe(false);
  });

  it("ignores credits, which are not spend", () => {
    const f = finance();
    f.bank!.ledger!.push({ account_id: "biz-1", payee: "Refund", amount: 50 });
    expect(vendorSpend(f).some((v) => v.payee === "Refund")).toBe(false);
  });

  it("uses the whole feed when no account is marked business", () => {
    const f = finance();
    f.bank!.accounts = [];
    expect(vendorSpend(f).some((v) => v.payee === "Groceries")).toBe(true);
  });
});

describe("adTargets", () => {
  const delivered = {
    totals: {
      pubImpressions: 220_000,
      pubPaidImpressions: 17_000,
      pubFreeImpressions: 203_000,
      pubClicks: 80,
      invalidClicks: 9_700,
      spentCents: 1_500,
    },
  };

  it("counts free delivery as delivery, because that is what the network runs on", () => {
    const t = adTargets(delivered);
    expect(t.impressions).toBe(220_000);
    expect(t.freeImpressions).toBe(203_000);
    expect(t.paidImpressions).toBe(17_000);
  });

  it("measures progress against the target rather than reporting a bare total", () => {
    const t = adTargets(delivered);
    expect(t.impressionProgress).toBeCloseTo(220_000 / 3_000_000);
    expect(t.ctr).toBeCloseTo(80 / 220_000);
    expect(t.ctrProgress).toBeCloseTo(80 / 220_000 / 0.05);
  });

  it("projects revenue at target from the price actually charged", () => {
    const t = adTargets(delivered);
    // 1,500c over 80 valid clicks.
    expect(t.cpcCents).toBeCloseTo(18.75);
    expect(t.projectedMonthlyUsd).toBeCloseTo((3_000_000 * 0.05 * 18.75) / 100);
  });

  it("refuses to project from a price nothing was ever sold at", () => {
    const t = adTargets({ totals: { pubImpressions: 100, pubClicks: 1, spentCents: 0 } });
    expect(t.cpcCents).toBeNull();
    expect(t.projectedMonthlyUsd).toBeNull();
  });

  it("takes overridden targets", () => {
    const t = adTargets(delivered, { targetImpressions: 1_000_000, targetCtr: 0.06 });
    expect(t.impressionProgress).toBeCloseTo(0.22);
    expect(t.targetCtr).toBe(0.06);
  });
});

describe("buildRoi", () => {
  it("never counts self-deal ad money as revenue or as cost", () => {
    const model = buildRoi({ traffic: traffic(), ads: ads(), finance: finance() });
    // Commission is the only revenue; the $50 of ad earnings is not in it.
    expect(model.revenue.perMonthUsd).toBe(120);
    expect(model.internal.adEarnedUsd).toBe(50);
    expect(model.internal.adSpendUsd).toBe(50);
    expect(model.internal.netUsd).toBe(0);
    // Cost is the business burn alone, with no ad spend added on top.
    expect(model.cost.perMonthUsd).toBe(2_000);
    expect(model.caveats.some((c) => c.includes("both sides of the network"))).toBe(true);
  });

  it("builds revenue from the day series, never from the lifetime headline", () => {
    // The regression this pins: `earnings` does not move when the window
    // changes, so it is lifetime. Rescaling it turned a dead merchant's
    // historical volume into a six-figure monthly run rate in production.
    const model = buildRoi({ traffic: traffic(), ads: ads(), finance: finance() });
    expect(model.revenue.commissionPerMonthUsd).toBeCloseTo(120);
    expect(model.revenue.grossVolumePerMonthUsd).toBeCloseTo(12_000);
    expect(model.revenue.lifetimeCommissionUsd).toBe(5_000);
    expect(model.revenue.observedDays).toBe(30);
    expect(model.revenue.estimated).toBe(false);
    expect(model.caveats.some((c) => c.includes("not a run rate"))).toBe(true);
  });

  it("does not change the revenue rate when the traffic window changes", () => {
    const month = buildRoi({ traffic: traffic(), ads: ads(), finance: finance() });
    const hour = buildRoi({
      traffic: { range: "1h", who: "humans", sites: [{ site: "a.com", visitors: 1, pageviews: 1 }] },
      ads: ads(),
      finance: { ...finance(), windowDays: 7 },
    });
    // Same underlying series, so the same rate. Before the fix a 7 day window
    // multiplied it by 30/7.
    expect(hour.revenue.perMonthUsd).toBeCloseTo(month.revenue.perMonthUsd);
  });

  it("says so loudly when there is no series to build a rate from", () => {
    const f = finance();
    delete f.series;
    const model = buildRoi({ traffic: traffic(), ads: ads(), finance: f });
    expect(model.revenue.estimated).toBe(true);
    expect(model.caveats.some((c) => c.includes("probably far too high"))).toBe(true);
  });

  it("names the window the burn is averaged over", () => {
    const model = buildRoi({ traffic: traffic(), ads: ads(), finance: finance() });
    expect(model.cost.lookbackDays).toBe(180);
  });

  it("computes the ratios a spend decision actually needs", () => {
    const model = buildRoi({ traffic: traffic(), ads: ads(), finance: finance() });
    expect(model.derived.roi).toBeCloseTo((120 - 2000) / 2000);
    expect(model.derived.netPerMonthUsd).toBe(-1_880);
    // 600 visitors in a 30d window against a $2,000/mo burn.
    expect(model.derived.costPerVisitorUsd).toBeCloseTo(2000 / 600);
    expect(model.derived.revenuePerVisitorUsd).toBeCloseTo(120 / 600);
    expect(model.derived.breakEvenVisitors).toBeCloseTo(2000 / (120 / 600));
    expect(model.attention.ctr).toBeCloseTo(20 / 1000);
  });

  it("prorates the monthly rate onto a short window rather than comparing a month of cost to an hour of traffic", () => {
    const model = buildRoi({
      traffic: traffic([{ site: "a.com", visitors: 10, pageviews: 12 }]),
      ads: ads(),
      finance: { ...finance(), windowDays: 30 },
    });
    expect(model.window.days).toBe(30);

    const hour = buildRoi({
      traffic: { range: "1h", who: "humans", sites: [{ site: "a.com", visitors: 10, pageviews: 12 }] },
      ads: ads(),
      finance: finance(),
    });
    expect(hour.cost.windowUsd).toBeCloseTo(2000 / 30 / 24);
    expect(hour.cost.perMonthUsd).toBe(2_000);
  });

  it("returns null ratios instead of dividing by nothing", () => {
    const model = buildRoi({
      traffic: { range: "1d", who: "humans", sites: [] },
      ads: null,
      finance: null,
    });
    expect(model.derived.roi).toBeNull();
    expect(model.derived.costPerVisitorUsd).toBeNull();
    expect(model.derived.breakEvenVisitors).toBeNull();
    expect(model.cost.perMonthUsd).toBe(0);
  });

  it("says when the vendor list is one page of a longer ledger", () => {
    const f = finance();
    f.bank!.ledgerTotal = 400;
    const model = buildRoi({ traffic: traffic(), ads: ads(), finance: f });
    expect(model.cost.vendorsPartial).toBe(true);
    expect(model.caveats.some((c) => c.includes("newest 4 of 400"))).toBe(true);
  });

  it("flags missing sites so a partial fan-out cannot read as a quiet day", () => {
    const model = buildRoi({
      traffic: traffic([
        { site: "a.com", visitors: 600, pageviews: 900 },
        { site: "b.com", visitors: 0, pageviews: 0, error: "500" },
      ]),
      ads: ads(),
      finance: finance(),
    });
    expect(model.attention.sitesReporting).toBe(1);
    expect(model.caveats.some((c) => c.includes("did not answer"))).toBe(true);
  });
});
