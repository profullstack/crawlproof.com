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
  /**
   * Per-slot delivery and earnings. Read by lib/dashboard/site.ts rather than
   * here — the fleet arithmetic wants the totals, one property wants its own
   * row — and joined to a project by `projectId`.
   */
  slots?: Array<{
    id?: string;
    name?: string;
    projectId?: string;
    status?: string;
    impressions?: number;
    clicks?: number;
    earnedCents?: number;
  }>;
  /** Per-campaign spend. `url` is the only field that names a domain. */
  campaigns?: Array<{
    id?: string;
    name?: string;
    status?: string;
    url?: string | null;
    impressions?: number;
    clicks?: number;
    spentCents?: number;
  }>;
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
  /**
   * The merchant's businesses. Read by lib/dashboard/site.ts, which can only
   * attribute commission to a domain when there is exactly one of them.
   */
  businesses?: Array<{ id?: string; name?: string }>;
  /**
   * The headline earnings figures, which are **lifetime and not windowed**.
   *
   * Verified against production 2026-09-06: asking CoinPay for 7 days and for
   * 30 returns byte-identical `grossVolumeUsd`, `commissionUsd` and
   * `transactions`, while the bank half of the same response does change. So
   * these are a balance, not a rate, and dividing them by a window they do not
   * cover invents revenue. They are reported as lifetime and never rescaled.
   */
  earnings?: { commissionUsd?: number; grossVolumeUsd?: number; netUsd?: number };
  /**
   * Volume by day, which IS windowed. This is the only honest basis for a
   * revenue rate, so it is what `revenue` is built from.
   */
  series?: Array<{ label?: string; volumeUsd?: number; commissionUsd?: number; count?: number }>;
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
    /** Days of bank history the burn rate is averaged over. */
    lookbackDays: number;
  };
  revenue: {
    /** Money from outside the fleet: the only kind that counts. */
    perMonthUsd: number;
    windowUsd: number;
    commissionPerMonthUsd: number;
    grossVolumePerMonthUsd: number;
    /** Days the series actually covers, which is what the rate is built on. */
    observedDays: number;
    /** Lifetime totals, shown for context and never used as a rate. */
    lifetimeCommissionUsd: number;
    lifetimeGrossVolumeUsd: number;
    /** True when there was no series and the rate had to be guessed. */
    estimated: boolean;
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

/** Where the ad network is trying to get to. Overridable from the CLI. */
export const AD_TARGET_IMPRESSIONS = 3_000_000;
export const AD_TARGET_CTR = 0.05;

export type AdTargets = {
  impressions: number;
  clicks: number;
  ctr: number | null;
  invalidClicks: number;
  freeImpressions: number;
  paidImpressions: number;
  /** Share of the impression target reached, 0..1+ */
  impressionProgress: number;
  ctrProgress: number;
  targetImpressions: number;
  targetCtr: number;
  /** Cents earned per valid click today, if any money has moved at all. */
  cpcCents: number | null;
  /**
   * What a month at target would earn at today's cost per click.
   *
   * Null when nothing has ever been charged, because a revenue projection
   * built on a made-up price is a forecast of the assumption, not of the
   * business.
   */
  projectedMonthlyUsd: number | null;
};

/**
 * Progress toward a working ad network, and what it would be worth.
 *
 * The network runs entirely on free backfill right now, so the paid columns
 * are near zero and leading with them would report a working network as a dead
 * one. Free delivery is delivery: it is the inventory being proved.
 */
export function adTargets(
  ads: AdsInput | null,
  {
    targetImpressions = AD_TARGET_IMPRESSIONS,
    targetCtr = AD_TARGET_CTR,
    cpcCents,
  }: { targetImpressions?: number; targetCtr?: number; cpcCents?: number | null } = {},
): AdTargets {
  const t = ads?.totals ?? {};
  const impressions = n(t.pubImpressions);
  const clicks = n(t.pubClicks);
  const spent = n(t.spentCents);
  const ctr = impressions > 0 ? clicks / impressions : null;

  const derivedCpc = clicks > 0 && spent > 0 ? spent / clicks : null;
  const cpc = cpcCents ?? derivedCpc;

  return {
    impressions,
    clicks,
    ctr,
    invalidClicks: n(t.invalidClicks),
    freeImpressions: n((t as { pubFreeImpressions?: number }).pubFreeImpressions),
    paidImpressions: n((t as { pubPaidImpressions?: number }).pubPaidImpressions),
    impressionProgress: targetImpressions > 0 ? impressions / targetImpressions : 0,
    ctrProgress: ctr !== null && targetCtr > 0 ? ctr / targetCtr : 0,
    targetImpressions,
    targetCtr,
    cpcCents: cpc,
    projectedMonthlyUsd: cpc === null ? null : (targetImpressions * targetCtr * cpc) / 100,
  };
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
  //
  // It comes from the day series, not from `earnings`. The headline earnings
  // figures do not move when the window changes (see the type), so they are
  // lifetime; rescaling them by a window they never covered is how a dead
  // merchant's historical volume becomes a six-figure monthly run rate.
  const financeDays = n(finance.windowDays) || 30;
  const series = finance.series ?? [];
  const seriesDays = series.length;
  const seriesCommission = series.reduce((t, p) => t + n(p.commissionUsd), 0);
  const seriesVolume = series.reduce((t, p) => t + n(p.volumeUsd), 0);

  const haveSeries = seriesDays > 0;
  const commissionPerMonth = haveSeries
    ? toMonthly(seriesCommission, seriesDays)
    : toMonthly(n(finance.earnings?.commissionUsd), financeDays);
  const grossPerMonth = haveSeries
    ? toMonthly(seriesVolume, seriesDays)
    : toMonthly(n(finance.earnings?.grossVolumeUsd), financeDays);
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
  if (!haveSeries) {
    caveats.push(
      `No day series from CoinPay, so revenue is a lifetime total rescaled from ${financeDays}d and is probably far too high.`,
    );
  }
  // The gap between the two is the whole reason the series is used. Naming it
  // keeps the big number visible without letting it be read as a rate.
  const lifetimeCommission = n(finance.earnings?.commissionUsd);
  if (haveSeries && lifetimeCommission > commissionPerMonth * 2) {
    caveats.push(
      `Lifetime commission is ${lifetimeCommission.toFixed(2)} against ${commissionPerMonth.toFixed(2)} in the last ${seriesDays}d. The rate here is the recent one; the lifetime figure is not a run rate.`,
    );
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
      lookbackDays: n(finance.position?.lookbackDays),
    },
    revenue: {
      perMonthUsd: revenuePerMonth,
      windowUsd: revenueWindow,
      commissionPerMonthUsd: commissionPerMonth,
      grossVolumePerMonthUsd: grossPerMonth,
      observedDays: haveSeries ? seriesDays : financeDays,
      lifetimeCommissionUsd: n(finance.earnings?.commissionUsd),
      lifetimeGrossVolumeUsd: n(finance.earnings?.grossVolumeUsd),
      estimated: !haveSeries,
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
