// One property, on its own: what arrived, what it cost, what it earned.
//
// The fleet screens answer "how are we doing". This answers "is THIS domain
// worth another week", which is a different question and needs the money split
// per property rather than summed across it.
//
// Pure, and built entirely from the snapshot the dashboard already collected —
// opening a domain fires no new request, so the detail screen can never
// disagree with the list it was opened from.
//
// Three money lines, each attributable by a different join, and each says which:
//
//   cost         the fleet's burn, prorated onto this property by its share of
//                traffic. Two of them, because the two denominators disagree by
//                orders of magnitude on this fleet (see the visitors caveat in
//                lib/dashboard/roi.ts) and picking one quietly would be a lie.
//   ad money     earnings by slot → project id, spend by campaign →
//                destination host. Both exact. Both internal: this network has
//                one account on both sides, so neither is revenue.
//   revenue      CoinPay commission, which is the only money from outside the
//                fleet — matched by business name/domain and fetched with that
//                business's id. Missing or unmatched analytics stay unknown.

import type { AdsInput, FinanceInput, RoiModel } from "./roi";
import { scoreSite, type ScoreItem, type ScoreModel } from "./score";

export type SitePoint = { date: string; pageviews: number; humans: number; bots: number; ai: number };

export type SiteMix = { humans: number; bots: number; ai: number; events: number };

/** What the collector carries for each property. */
export type SiteLike = {
  site: string;
  id?: string;
  url?: string;
  visitors: number;
  pageviews: number;
  sources: ScoreItem[];
  referrers: ScoreItem[];
  pages: ScoreItem[];
  series?: SitePoint[];
  mix?: SiteMix;
  error?: string;
};

export type SiteMoney = {
  /** Burn prorated by this property's share of fleet pageviews. */
  costByViewsUsd: number | null;
  /** The same, by its share of fleet visits. Flattering; see the module note. */
  costByVisitsUsd: number | null;
  adEarnedUsd: number;
  adSpentUsd: number;
  adImpressions: number;
  adClicks: number;
  /** Money from outside the fleet, or null when it cannot be attributed here. */
  revenueUsd: number | null;
  /** How `revenueUsd` was arrived at, for the screen to print. */
  revenueBasis: string;
  /** Actual payment volume and count over the CoinPay observation window. */
  grossVolumeUsd: number | null;
  transactions: number | null;
  observedDays: number | null;
  /** Revenue per 1,000 human visits, when both halves exist. */
  rpmUsd: number | null;
  /** Revenue less the cost-by-views share. Null when either half is null. */
  netUsd: number | null;
};

export type SiteDetail = {
  site: string;
  url: string | null;
  error: string | null;
  window: { range: string; who: string; days: number; financeDays: number };
  traffic: {
    visitors: number;
    pageviews: number;
    humans: number;
    bots: number;
    aiReferrals: number;
    /** humans / (humans + bots), or null when the mix is unknown. */
    humanShare: number | null;
    mixKnown: boolean;
    visitShare: number;
    viewShare: number;
    series: SitePoint[];
    sources: ScoreItem[];
    referrers: ScoreItem[];
    pages: ScoreItem[];
  };
  money: SiteMoney;
  score: ScoreModel;
  /** What could not be attributed to this property, named rather than guessed. */
  gaps: string[];
};

const num = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const cents = (v: unknown): number => num(v) / 100;

const share = (part: number, whole: number): number => (whole > 0 ? num(part) / whole : 0);

/**
 * A hostname from a URL or a bare host, lowercased and de-`www`'d.
 *
 * Deliberately not lib/ads/slots' `hostOf`: this module is bundled into the
 * published CLI, and that one reaches through net-guard into server code.
 */
export function hostFrom(input: string | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** True when a site row and a URL name the same property. */
export function sameProperty(site: SiteLike, url: string | null | undefined): boolean {
  const target = hostFrom(url);
  if (!target) return false;
  const host = hostFrom(site.url) ?? hostFrom(site.site);
  if (host && host === target) return true;
  // A project named for its host but with no URL on file still matches.
  return site.site.toLowerCase() === target;
}

/** Self-referrals and loopback checks are existing traffic, not new discovery. */
export function sourcesForScore(site: SiteLike): ScoreItem[] {
  const grouped = new Map<string, number>();
  for (const source of site.sources ?? []) {
    const referral = /^referral\s*(?:·|:)\s*(.+)$/i.exec(source.label)?.[1];
    const host = hostFrom(referral);
    const local = host === "localhost" || host === "0.0.0.0" || host === "[::1]" || /^127\./.test(host ?? "");
    const label = referral && (sameProperty(site, referral) || local) ? "Internal referral" : source.label;
    grouped.set(label, (grouped.get(label) ?? 0) + num(source.value));
  }
  return [...grouped].map(([label, value]) => ({ label, value }));
}

/**
 * CoinPay commission attributable to one property.
 *
 * Prefer analytics requested with a business id. Older snapshots can supply a
 * windowed series only if their sole business matches this property.
 */
export function coinpayRevenueForSite(
  finance: FinanceInput | null,
  roi: RoiModel,
  site: SiteLike,
): { usd: number | null; basis: string; grossVolumeUsd: number | null; transactions: number | null; observedDays: number | null } {
  const unknown = (basis: string) => ({ usd: null, basis, grossVolumeUsd: null, transactions: null, observedDays: null });
  const businesses = finance?.businesses ?? [];
  if (!finance) return unknown("no CoinPay session");
  const matches = businesses.filter((b) =>
    sameProperty(site, b.name) || site.site.toLowerCase() === b.name?.toLowerCase(),
  );
  if (finance.businessRevenue) {
    if (!matches.length) return unknown("no CoinPay business matches this domain");
    const rows = matches.map((b) => b.id ? finance.businessRevenue?.[b.id] : undefined);
    for (const row of rows) {
      if (!row || row.error || row.commissionUsd == null || row.grossVolumeUsd == null || row.transactions == null || !(row.windowDays > 0)) {
        return unknown(row?.error ?? "business analytics unavailable");
      }
    }
    const observedDays = rows[0]!.windowDays;
    if (rows.some((row) => row!.windowDays !== observedDays)) return unknown("business windows do not match");
    const commission = rows.reduce((total, row) => total + num(row!.commissionUsd), 0);
    return {
      usd: commission * roi.window.days / observedDays,
      basis: `CoinPay: ${matches.map((b) => b.name).join(", ")} · ${observedDays}d commission prorated to ${roi.window.range}`,
      grossVolumeUsd: rows.reduce((total, row) => total + num(row!.grossVolumeUsd), 0),
      transactions: rows.reduce((total, row) => total + num(row!.transactions), 0),
      observedDays,
    };
  }
  if (businesses.length !== 1) {
    return unknown(businesses.length
        ? `${businesses.length} CoinPay businesses, no per-business split in the snapshot`
        : "CoinPay reported no businesses");
  }
  const only = businesses[0] as { id?: string; name?: string };
  const name = String(only?.name ?? "");
  if (!(sameProperty(site, name) || site.site.toLowerCase() === name.toLowerCase())) {
    return unknown(`all commission belongs to ${name || "another business"}`);
  }
  if (finance.errors?.analytics || !finance.series?.length) {
    return unknown(finance.errors?.analytics ?? "no windowed CoinPay series");
  }
  return {
    usd: num(roi.revenue.windowUsd),
    basis: `all CoinPay commission (${name}) · ${roi.revenue.observedDays}d prorated to ${roi.window.range}`,
    grossVolumeUsd: finance.series.reduce((total, point) => total + num(point.volumeUsd), 0),
    transactions: finance.series.reduce((total, point) => total + num(point.count), 0),
    observedDays: roi.revenue.observedDays,
  };
}

/** Ad money and delivery for one property, joined exactly rather than shared out. */
export function adMoneyForSite(
  ads: AdsInput | null,
  site: SiteLike,
): { earnedUsd: number; spentUsd: number; impressions: number; clicks: number } {
  const model = (ads ?? {}) as AdsInput & {
    slots?: Array<{ projectId?: string; name?: string; earnedCents?: number; impressions?: number; clicks?: number }>;
    campaigns?: Array<{ url?: string | null; spentCents?: number }>;
  };
  const out = { earnedUsd: 0, spentUsd: 0, impressions: 0, clicks: 0 };

  for (const slot of model.slots ?? []) {
    const mine = site.id ? slot.projectId === site.id : slot.name === site.site;
    if (!mine) continue;
    out.earnedUsd += cents(slot.earnedCents);
    out.impressions += num(slot.impressions);
    out.clicks += num(slot.clicks);
  }
  for (const campaign of model.campaigns ?? []) {
    if (!sameProperty(site, campaign.url)) continue;
    out.spentUsd += cents(campaign.spentCents);
  }
  return out;
}

export type BuildSiteDetailInput = {
  site: SiteLike;
  roi: RoiModel;
  ads: AdsInput | null;
  finance: FinanceInput | null;
  window: { range: string; who: string; financeDays: number };
};

export function buildSiteDetail(input: BuildSiteDetailInput): SiteDetail {
  const { site, roi } = input;
  const gaps: string[] = [];

  const series = site.series ?? [];
  const mix = site.mix;
  // Under `who=all` a filtered read was never made, so the mix IS the series;
  // under humans or bots it is the second, unfiltered read the API adds. When
  // neither is there the share is unknown, and unknown is not 100%.
  const mixKnown = Boolean(mix && mix.humans + mix.bots > 0);
  const humans = mixKnown ? num(mix?.humans) : series.reduce((t, p) => t + num(p.humans), 0);
  const bots = mixKnown ? num(mix?.bots) : 0;
  const aiReferrals = mixKnown ? num(mix?.ai) : series.reduce((t, p) => t + num(p.ai), 0);
  const humanShare = mixKnown && humans + bots > 0 ? humans / (humans + bots) : null;

  if (!series.length && !site.error) {
    gaps.push("No series for this window, so momentum and volatility are unscored.");
  }
  if (!mixKnown && !site.error) {
    gaps.push("The humans-against-bots mix is missing; press b for All to see both sides.");
  }

  const visitShare = share(site.visitors, roi.attention.visitors);
  const viewShare = share(site.pageviews, roi.attention.pageviews);
  const costWindow = num(roi.cost.windowUsd);
  const costKnown = Boolean(input.finance?.position && !input.finance.errors?.summary && !site.error);
  const costByViews = costKnown && roi.attention.pageviews > 0 ? costWindow * viewShare : null;
  const costByVisits = costKnown && roi.attention.visitors > 0 ? costWindow * visitShare : null;

  const ad = adMoneyForSite(input.ads, site);
  const revenue = coinpayRevenueForSite(input.finance, roi, site);
  if (revenue.usd === null) {
    gaps.push(`Revenue is not attributable to one domain here: ${revenue.basis}.`);
  } else {
    gaps.push(revenue.basis);
  }

  // The earn rail is a network-wide pool — crawler pass revenue funds it with
  // the pass payment's own ref and no project column — so there is no per-domain
  // figure to show. Named rather than omitted, because a missing money line on
  // a money screen reads as a zero.
  gaps.push("Earn-rail rewards are pooled network-wide; there is no per-domain share to report.");
  const scoreSources = input.window.who === "bots" ? [] : sourcesForScore(site);
  if (scoreSources.some((s) => s.label === "Internal referral")) {
    gaps.push("Self-referrals and localhost traffic do not count as discovery.");
  }

  // Human visits are the denominator for a per-reader figure, and the score
  // half that pays attention to money uses the same one. Ad earnings are
  // internal and deliberately excluded: see the two rules in roi.ts.
  const rpmUsd = humans > 0 && revenue.usd !== null ? (revenue.usd * 1000) / humans : null;

  // A site whose stats call failed is not scored at all. Its sources list may
  // still hold something from a previous shape, and scoring off half an answer
  // would rank a site we could not reach against sites we could.
  //
  // Otherwise: momentum and volatility read the shape of the series, which is
  // filtered to whichever side was asked for; humanity, money and the sample
  // floor read the unfiltered totals, the only place both sides are counted.
  const score = site.error
    ? scoreSite({ humans: [], sources: [], mixKnown: false })
    : scoreSite({
        humans: series.map((p) => num(p.humans)),
        bots: series.map((p) => num(p.bots)),
        sources: scoreSources,
        revenueUsd: revenue.usd,
        mixKnown,
        ...(mixKnown ? { humansTotal: humans, botsTotal: bots } : {}),
      });
  if (site.error) {
    gaps.push("This site did not answer, so it is unscored rather than scored zero.");
  }

  if (input.window.who === "bots") {
    gaps.push("A bots-only window has no human series, so momentum and volatility are unscored.");
  }

  return {
    site: site.site,
    url: site.url ?? null,
    error: site.error ?? null,
    window: {
      range: input.window.range,
      who: input.window.who,
      days: roi.window.days,
      financeDays: input.window.financeDays,
    },
    traffic: {
      visitors: num(site.visitors),
      pageviews: num(site.pageviews),
      humans,
      bots,
      aiReferrals,
      humanShare,
      mixKnown,
      visitShare,
      viewShare,
      series,
      sources: site.sources ?? [],
      referrers: site.referrers ?? [],
      pages: site.pages ?? [],
    },
    money: {
      costByViewsUsd: costByViews,
      costByVisitsUsd: costByVisits,
      adEarnedUsd: ad.earnedUsd,
      adSpentUsd: ad.spentUsd,
      adImpressions: ad.impressions,
      adClicks: ad.clicks,
      revenueUsd: revenue.usd,
      revenueBasis: revenue.basis,
      grossVolumeUsd: revenue.grossVolumeUsd,
      transactions: revenue.transactions,
      observedDays: revenue.observedDays,
      rpmUsd,
      netUsd: revenue.usd === null || costByViews === null ? null : revenue.usd - costByViews,
    },
    score,
    gaps,
  };
}
