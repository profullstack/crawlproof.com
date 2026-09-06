import { describe, expect, it } from "vitest";

import {
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
  earnings: { commissionUsd: 120, grossVolumeUsd: 12_000, netUsd: 11_880 },
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
