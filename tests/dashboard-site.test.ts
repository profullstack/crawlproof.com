/**
 * One property's own numbers.
 *
 * The joins are the whole point of this module and each of them is a different
 * one — earnings by project id, spend by destination host, commission only when
 * there is exactly one business to attribute it to — so each is pinned here,
 * along with the refusals: what this cannot attribute it must say rather than
 * divide out.
 */
import { describe, expect, it } from "vitest";

import { buildRoi, type AdsInput, type FinanceInput } from "@/lib/dashboard/roi";
import {
  adMoneyForSite,
  buildSiteDetail,
  coinpayRevenueForSite,
  hostFrom,
  sameProperty,
  type SiteLike,
} from "@/lib/dashboard/site";

const site = (over: Partial<SiteLike> = {}): SiteLike => ({
  site: "nichedb.dev",
  id: "p-1",
  url: "https://nichedb.dev/",
  visitors: 400,
  pageviews: 100,
  sources: [
    { label: "Search · google", value: 60 },
    { label: "Direct", value: 40 },
  ],
  referrers: [],
  pages: [{ label: "/", value: 80 }],
  series: Array.from({ length: 8 }, (_, i) => ({
    date: `2026-09-0${i + 1}`,
    pageviews: 10 + i,
    humans: 10 + i,
    bots: 2,
    ai: 1,
  })),
  mix: { humans: 116, bots: 16, ai: 8, events: 132 },
  ...over,
});

const ads = (): AdsInput => ({
  rangeDays: 30,
  totals: { spentCents: 500, earnedCents: 700, pubImpressions: 10_000, pubClicks: 20 },
  slots: [
    { id: "s-1", name: "nichedb.dev", projectId: "p-1", impressions: 900, clicks: 3, earnedCents: 250 },
    { id: "s-2", name: "other.dev", projectId: "p-2", impressions: 50, clicks: 0, earnedCents: 400 },
  ],
  campaigns: [
    { id: "c-1", name: "NicheDB", url: "https://www.nichedb.dev/pricing", spentCents: 120 },
    { id: "c-2", name: "Other", url: "https://other.dev/", spentCents: 999 },
    { id: "c-3", name: "Broken", url: null, spentCents: 777 },
  ],
});

const finance = (businesses: Array<{ id?: string; name?: string }>): FinanceInput => ({
  windowDays: 30,
  businesses,
  earnings: { commissionUsd: 900, grossVolumeUsd: 90_000 },
  series: Array.from({ length: 30 }, () => ({ volumeUsd: 100, commissionUsd: 1 })),
  position: {
    lookbackDays: 180,
    monthsObserved: 6,
    spending: { perMonth: 3_000 },
    scopes: [{ scope: "business", spending: 18_000, income: 600, accounts: 1 }],
  },
  bank: { accounts: [], ledger: [], ledgerTotal: 0 },
});

const roiFor = (sites: SiteLike[], fin: FinanceInput | null = finance([])) =>
  buildRoi({
    traffic: {
      range: "1m",
      who: "humans",
      sites: sites.map((s) => ({ site: s.site, visitors: s.visitors, pageviews: s.pageviews })),
    },
    ads: ads(),
    finance: fin,
  });

describe("hostFrom", () => {
  it("takes a host out of a URL, a bare host, or neither", () => {
    expect(hostFrom("https://www.NicheDB.dev/pricing?x=1")).toBe("nichedb.dev");
    expect(hostFrom("nichedb.dev")).toBe("nichedb.dev");
    expect(hostFrom("")).toBeNull();
    expect(hostFrom(null)).toBeNull();
    expect(hostFrom("   ")).toBeNull();
  });
});

describe("sameProperty", () => {
  it("matches on the project URL, on the project name, and ignores www", () => {
    expect(sameProperty(site(), "https://www.nichedb.dev/a")).toBe(true);
    expect(sameProperty(site({ url: undefined }), "https://nichedb.dev/")).toBe(true);
    expect(sameProperty(site(), "https://other.dev/")).toBe(false);
    expect(sameProperty(site(), null)).toBe(false);
  });
});

describe("adMoneyForSite", () => {
  it("takes earnings by project id and spend by where the campaign points", () => {
    const money = adMoneyForSite(ads(), site());
    expect(money.earnedUsd).toBeCloseTo(2.5);
    expect(money.spentUsd).toBeCloseTo(1.2);
    expect(money.impressions).toBe(900);
    expect(money.clicks).toBe(3);
  });

  it("is all zeros, not a share of the fleet, when nothing matches", () => {
    const money = adMoneyForSite(ads(), site({ id: "p-9", site: "nobody.dev", url: "https://nobody.dev" }));
    expect(money).toEqual({ earnedUsd: 0, spentUsd: 0, impressions: 0, clicks: 0 });
  });

  it("survives an absent ads feed", () => {
    expect(adMoneyForSite(null, site()).earnedUsd).toBe(0);
  });
});

describe("coinpayRevenueForSite", () => {
  it("attributes the whole commission when there is exactly one matching business", () => {
    const fin = finance([{ id: "b-1", name: "nichedb.dev" }]);
    const result = coinpayRevenueForSite(fin, roiFor([site()], fin), site());
    expect(result.usd).toBeGreaterThan(0);
    expect(result.basis).toContain("nichedb.dev");
  });

  it("refuses rather than sharing it out across several businesses", () => {
    const fin = finance([{ name: "a" }, { name: "b" }]);
    const result = coinpayRevenueForSite(fin, roiFor([site()], fin), site());
    expect(result.usd).toBeNull();
    expect(result.basis).toMatch(/no per-business split/);
  });

  it("refuses when the one business is a different property", () => {
    const fin = finance([{ name: "coinpayportal.com" }]);
    expect(coinpayRevenueForSite(fin, roiFor([site()], fin), site()).usd).toBeNull();
  });

  it("says there is no session rather than reporting zero", () => {
    expect(coinpayRevenueForSite(null, roiFor([site()], null), site()).basis).toMatch(/no CoinPay session/);
  });
});

describe("buildSiteDetail", () => {
  const build = (over: Partial<SiteLike> = {}, fin: FinanceInput | null = finance([])) => {
    const rows = [site(over), site({ site: "other.dev", id: "p-2", url: "https://other.dev", visitors: 600, pageviews: 900 })];
    return buildSiteDetail({
      site: rows[0] as SiteLike,
      roi: roiFor(rows, fin),
      ads: ads(),
      finance: fin,
      window: { range: "1m", who: "humans", financeDays: 30 },
    });
  };

  it("prorates cost by both denominators, because they disagree by orders of magnitude", () => {
    const detail = build();
    // 100 of 1,000 pageviews, but 400 of 1,000 visits.
    expect(detail.traffic.viewShare).toBeCloseTo(0.1);
    expect(detail.traffic.visitShare).toBeCloseTo(0.4);
    expect(detail.money.costByVisitsUsd as number).toBeGreaterThan(detail.money.costByViewsUsd as number);
  });

  it("reads the human / bot split from the unfiltered mix, not from the filtered series", () => {
    const detail = build();
    expect(detail.traffic.mixKnown).toBe(true);
    expect(detail.traffic.humans).toBe(116);
    expect(detail.traffic.bots).toBe(16);
    expect(detail.traffic.humanShare as number).toBeCloseTo(116 / 132);
  });

  it("says the mix is unknown rather than calling a site 100% human", () => {
    const detail = build({ mix: undefined });
    expect(detail.traffic.mixKnown).toBe(false);
    expect(detail.traffic.humanShare).toBeNull();
    expect(detail.gaps.join(" ")).toMatch(/mix is missing/i);
  });

  it("names the earn rail as pooled rather than leaving a money line blank", () => {
    expect(build().gaps.join(" ")).toMatch(/Earn-rail/);
  });

  it("has no revenue, no RPM and no net when revenue cannot be attributed", () => {
    const detail = build();
    expect(detail.money.revenueUsd).toBeNull();
    expect(detail.money.rpmUsd).toBeNull();
    expect(detail.money.netUsd).toBeNull();
    expect(detail.gaps.join(" ")).toMatch(/not attributable/);
  });

  it("computes revenue per 1k humans once there is revenue to divide", () => {
    const fin = finance([{ name: "nichedb.dev" }]);
    const detail = build({}, fin);
    expect(detail.money.revenueUsd as number).toBeGreaterThan(0);
    expect(detail.money.rpmUsd as number).toBeCloseTo(((detail.money.revenueUsd as number) * 1000) / 116);
    expect(Number.isFinite(detail.money.netUsd as number)).toBe(true);
  });

  it("carries a failed site through as missing rather than as a quiet day", () => {
    const detail = build({ error: "504 Gateway Timeout", series: [], mix: undefined, visitors: 0, pageviews: 0 });
    expect(detail.error).toBe("504 Gateway Timeout");
    expect(detail.score.score).toBeNull();
  });

  it("scores the property and keeps it in range", () => {
    const detail = build();
    expect(detail.score.score).not.toBeNull();
    expect(detail.score.score as number).toBeGreaterThanOrEqual(0);
    expect(detail.score.score as number).toBeLessThanOrEqual(100);
    expect(detail.score.viralComponents).toHaveLength(4);
    expect(detail.score.riskComponents).toHaveLength(4);
  });

  it("says a bots-only window cannot carry momentum", () => {
    const rows = [site()];
    const detail = buildSiteDetail({
      site: rows[0] as SiteLike,
      roi: roiFor(rows),
      ads: ads(),
      finance: finance([]),
      window: { range: "1m", who: "bots", financeDays: 30 },
    });
    expect(detail.gaps.join(" ")).toMatch(/bots-only/);
  });
});
