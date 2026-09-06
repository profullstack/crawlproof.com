// What the fleet costs, what it returns, and the ratio between them.
//
// Three sources answer three different questions and none of them answers this
// one alone: CrawlProof knows who showed up, the ad network knows what was
// delivered, and CoinPay knows what the bank actually did. This module is the
// arithmetic that joins them, kept pure so it can be tested against real
// shapes without a network.
//
// Two rules run through all of it, and both exist because breaking either one
// produces a flattering number that is false:
//
//  1. **Self-deal is not revenue.** The ad network runs with one account on
//     both sides — we advertise on our own slots — so `spentCents` and
//     `earnedCents` are the same dollar leaving one pocket and arriving in the
//     other. They are reported under `internal`, never added to revenue, and
//     `internal.net` should stay near zero. If it ever does not, that is a
//     bug in the ledger rather than a profit.
//  2. **Personal money is not fleet cost.** The bank feed carries one human's
//     groceries next to the servers. Only the `business` scope is spend.
//
// Everything is normalised to a **monthly rate** and then prorated onto the
// traffic window. Burn is a rate, not a balance, and a rate survives the fact
// that the traffic side can be asked for an hour while the bank side only
// answers in weeks.

/** Days covered by each tracker range, for prorating a monthly rate onto it. */
export const RANGE_DAYS: Record<string, number> = {
  "1h": 1 / 24,
  "4h": 1 / 6,
  "1d": 1,
  "1w": 7,
  "1m": 30,
};

export function rangeDays(range: string): number {
  return RANGE_DAYS[range] ?? 1;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const cents = (v: unknown): number => n(v) / 100;

/** One site's slice of the fleet's traffic. */
export type SiteTraffic = {
  site: string;
  visitors: number;
  pageviews: number;
  /** Set when this site's stats call failed; its numbers are zero, not observed. */
  error?: string;
};

export type TrafficInput = {
  range: string;
  who: string;
  sites: SiteTraffic[];
};

/** The subset of /api/ads/v1/earnings this module reads. */
export type AdsInput = {
  rangeDays?: number;
  statsUnavailable?: boolean;
  totals?: {
    spentCents?: number;
    earnedCents?: number;
    availableCents?: number;
    advImpressions?: number;
    advClicks?: number;
    pubImpressions?: number;
    pubClicks?: number;
    invalidClicks?: number;
  };
};

/** The subset of the CoinPay finance snapshot this module reads. */
export type FinanceInput = {
  windowDays?: number;
  earnings?: { commissionUsd?: number; grossVolumeUsd?: number; netUsd?: number };
  position?: {
    lookbackDays?: number;
    monthsObserved?: number;
    spending?: { perMonth?: number };
    income?: { perMonth?: number };
    ratios?: { monthsOfCover?: number | null };
    scopes?: Array<{
      scope?: string;
      spending?: number;
      income?: number;
      accounts?: number;
    }>;
  };
  bank?: {
    /**
     * A ledger row names an account, not a scope — `effective_scope` lives on
     * the account. Joining the two is what keeps groceries out of the fleet's
     * bill, so both halves are required.
     */
    accounts?: Array<{ id?: string; effective_scope?: string | null; name?: string | null }>;
    ledger?: Array<{
      account_id?: string | null;
      payee?: string | null;
      description?: string | null;
      amount?: number | null;
      category?: string | null;
      posted?: string | null;
    }>;
    /** Rows in the window; `ledger` may be one page of it. */
    ledgerTotal?: number;
  };
};

export type VendorSpend = { payee: string; usd: number; charges: number };

export type RoiModel = {
  window: { range: string; days: number; who: string };
  cost: {
    /** Business-scope burn, the rate everything else is prorated from. */
    perMonthUsd: number;
    /** That rate over the traffic window. */
    windowUsd: number;
    /** True when the bank feed never labelled an account business. */
    scopeMissing: boolean;
    /** Whole-feed burn including personal, for context only. */
    allScopesPerMonthUsd: number;
    vendors: VendorSpend[];
    /** True when `vendors` was built from one page of a longer ledger. */
    vendorsPartial: boolean;
  };
  revenue: {
    /** Money from outside the fleet: the only kind that counts. */
    perMonthUsd: number;
    windowUsd: number;
    commissionPerMonthUsd: number;
    grossVolumePerMonthUsd: number;
  };
  /** Money moving between our own products. Never revenue; see rule 1. */
  internal: {
    adSpendUsd: number;
    adEarnedUsd: number;
    netUsd: number;
    availableUsd: number;
  };
  attention: {
    visitors: number;
    pageviews: number;
    sites: number;
    sitesReporting: number;
    impressions: number;
    clicks: number;
    ctr: number | null;
  };
  derived: {
    netPerMonthUsd: number;
    /** (revenue − cost) / cost. Null when there is no cost to divide by. */
    roi: number | null;
    costPerVisitorUsd: number | null;
    /**
     * The sturdier denominator. A "visitor" here is any visit the tracker did
     * not classify as a crawler, which on a site with a machine-readable
     * endpoint runs orders of magnitude above the pages anyone actually read.
     */
    costPerPageviewUsd: number | null;
    revenuePerVisitorUsd: number | null;
    /** Visitors per month needed to cover burn at the current revenue/visitor. */
    breakEvenVisitors: number | null;
    monthsOfCover: number | null;
  };
  /** Why a number is missing or should not be read straight. */
  caveats: string[];
};

/**
 * Sum a fleet's worth of per-site stats.
 *
 * Sites whose stats call failed are counted in `sites` but not in
 * `sitesReporting`, so a partial fan-out cannot quietly read as a quiet day.
 */
export function sumTraffic(sites: SiteTraffic[]): {
  visitors: number;
  pageviews: number;
  sites: number;
  sitesReporting: number;
} {
  let visitors = 0;
  let pageviews = 0;
  let reporting = 0;
  for (const s of sites) {
    if (s.error) continue;
    reporting += 1;
    visitors += n(s.visitors);
    pageviews += n(s.pageviews);
  }
  return { visitors, pageviews, sites: sites.length, sitesReporting: reporting };
}

/**
 * Business-scope spend as a monthly rate.
 *
 * Prefers the per-scope split; falls back to the whole-feed rate when no
 * account has been marked business, and says so through `scopeMissing` rather
 * than silently billing the fleet for someone's groceries.
 */
export function businessBurn(finance: FinanceInput): {
  perMonthUsd: number;
  allScopesPerMonthUsd: number;
  scopeMissing: boolean;
} {
  const position = finance.position ?? {};
  const allScopes = n(position.spending?.perMonth);
  const months = n(position.monthsObserved);
  const scopes = position.scopes ?? [];
  const business = scopes.find((s) => s?.scope === "business");

  // `scopes[].spending` is a total over the lookback, not a rate; the observed
  // month count is what turns it into one.
  if (business && months > 0) {
    return {
      perMonthUsd: n(business.spending) / months,
      allScopesPerMonthUsd: allScopes,
      scopeMissing: false,
    };
  }
  return { perMonthUsd: allScopes, allScopesPerMonthUsd: allScopes, scopeMissing: true };
}

/** Ids of the accounts the feed considers business. */
export function businessAccountIds(finance: FinanceInput): Set<string> {
  const ids = new Set<string>();
  for (const a of finance.bank?.accounts ?? []) {
    if (a?.id && a.effective_scope === "business") ids.add(a.id);
  }
  return ids;
}

/**
 * Who we actually pay, largest first.
 *
 * Debits only, business accounts only, and grouped by payee so twelve
 * Anthropic charges read as one line with a number worth acting on. With no
 * business account marked the whole feed is used, which is wrong but visibly
 * wrong — `buildRoi` raises the same caveat for the burn rate.
 */
export function vendorSpend(finance: FinanceInput, limit = 12): VendorSpend[] {
  const rows = finance.bank?.ledger ?? [];
  const business = businessAccountIds(finance);
  const byPayee = new Map<string, VendorSpend>();
  for (const row of rows) {
    const amount = n(row?.amount);
    if (amount >= 0) continue; // credits and refunds are not spend
    if (business.size > 0 && !business.has(String(row?.account_id ?? ""))) continue;
    const payee = (row?.payee || row?.description || "Unknown").trim() || "Unknown";
    const prev = byPayee.get(payee) ?? { payee, usd: 0, charges: 0 };
    prev.usd += Math.abs(amount);
    prev.charges += 1;
    byPayee.set(payee, prev);
  }
  return [...byPayee.values()].sort((a, b) => b.usd - a.usd).slice(0, limit);
}

/** Turn a figure covering `days` into a monthly rate. */
export function toMonthly(total: number, days: number): number {
  if (!(days > 0)) return 0;
  return (n(total) * 30) / days;
}

export function buildRoi(input: {
  traffic: TrafficInput;
  ads: AdsInput | null;
  finance: FinanceInput | null;
}): RoiModel {
  const { traffic } = input;
  const ads = input.ads ?? {};
  const finance = input.finance ?? {};
  const days = rangeDays(traffic.range);
  const caveats: string[] = [];

  const attention = sumTraffic(traffic.sites ?? []);
  const adTotals = ads.totals ?? {};
  const impressions = n(adTotals.pubImpressions);
  const clicks = n(adTotals.pubClicks);

  const burn = businessBurn(finance);
  const costWindow = (burn.perMonthUsd * days) / 30;

  // Commission is our cut of merchant volume and the only line here that is
  // money from outside the fleet.
  const financeDays = n(finance.windowDays) || 30;
  const commissionPerMonth = toMonthly(n(finance.earnings?.commissionUsd), financeDays);
  const grossPerMonth = toMonthly(n(finance.earnings?.grossVolumeUsd), financeDays);
  const revenuePerMonth = commissionPerMonth;
  const revenueWindow = (revenuePerMonth * days) / 30;

  const adSpendUsd = cents(adTotals.spentCents);
  const adEarnedUsd = cents(adTotals.earnedCents);

  const netPerMonth = revenuePerMonth - burn.perMonthUsd;
  const roi = burn.perMonthUsd > 0 ? (revenuePerMonth - burn.perMonthUsd) / burn.perMonthUsd : null;

  const costPerVisitor = attention.visitors > 0 ? costWindow / attention.visitors : null;
  const costPerPageview = attention.pageviews > 0 ? costWindow / attention.pageviews : null;
  const revenuePerVisitor = attention.visitors > 0 ? revenueWindow / attention.visitors : null;
  const breakEvenVisitors =
    revenuePerVisitor && revenuePerVisitor > 0 ? burn.perMonthUsd / revenuePerVisitor : null;

  if (burn.scopeMissing) {
    caveats.push(
      "No account is marked business, so spend is the whole bank feed — personal included.",
    );
  }
  if (attention.sitesReporting < attention.sites) {
    caveats.push(
      `${attention.sites - attention.sitesReporting} of ${attention.sites} sites did not answer; their traffic is missing, not zero.`,
    );
  }
  if (ads.statsUnavailable) {
    caveats.push("An ad delivery query failed; impressions and clicks are zero-filled.");
  }
  // A visit is any non-crawler hit, a pageview is a rendered page. When the
  // first dwarfs the second the fleet is being measured by something that
  // never read anything, and per-visitor money is the wrong number to quote.
  if (attention.pageviews > 0 && attention.visitors > attention.pageviews * 5) {
    caveats.push(
      `${Math.round(attention.visitors / attention.pageviews)}× more visits than pageviews — most arrivals never rendered a page. Prefer the per-pageview figure.`,
    );
  }
  const busiest = [...(traffic.sites ?? [])]
    .filter((s) => !s.error)
    .sort((a, b) => n(b.visitors) - n(a.visitors))[0];
  if (busiest && attention.visitors > 0 && n(busiest.visitors) > attention.visitors * 0.5) {
    caveats.push(
      `${busiest.site} is ${Math.round((n(busiest.visitors) / attention.visitors) * 100)}% of fleet visits, so a fleet average mostly describes that one site.`,
    );
  }
  if (adSpendUsd > 0 || adEarnedUsd > 0) {
    caveats.push(
      "Ad spend and ad earnings are the same account on both sides of the network, so neither is counted as cost or revenue.",
    );
  }
  if (financeDays !== 30) {
    caveats.push(`CoinPay figures cover ${financeDays}d, rescaled to a monthly rate.`);
  }
  const ledgerRows = finance.bank?.ledger?.length ?? 0;
  const ledgerTotal = n(finance.bank?.ledgerTotal);
  const vendorsPartial = ledgerTotal > ledgerRows;
  if (vendorsPartial) {
    caveats.push(
      `Vendors cover the newest ${ledgerRows} of ${ledgerTotal} transactions; the burn rate above does not.`,
    );
  }

  return {
    window: { range: traffic.range, days, who: traffic.who },
    cost: {
      perMonthUsd: burn.perMonthUsd,
      windowUsd: costWindow,
      scopeMissing: burn.scopeMissing,
      allScopesPerMonthUsd: burn.allScopesPerMonthUsd,
      vendors: vendorSpend(finance),
      vendorsPartial,
    },
    revenue: {
      perMonthUsd: revenuePerMonth,
      windowUsd: revenueWindow,
      commissionPerMonthUsd: commissionPerMonth,
      grossVolumePerMonthUsd: grossPerMonth,
    },
    internal: {
      adSpendUsd,
      adEarnedUsd,
      netUsd: adEarnedUsd - adSpendUsd,
      availableUsd: cents(adTotals.availableCents),
    },
    attention: {
      ...attention,
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : null,
    },
    derived: {
      netPerMonthUsd: netPerMonth,
      roi,
      costPerVisitorUsd: costPerVisitor,
      costPerPageviewUsd: costPerPageview,
      revenuePerVisitorUsd: revenuePerVisitor,
      breakEvenVisitors,
      monthsOfCover: finance.position?.ratios?.monthsOfCover ?? null,
    },
    caveats,
  };
}
