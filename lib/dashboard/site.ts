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
//                fleet — and is attributable to a domain only when the merchant
//                account has exactly one business and it is this one. Otherwise
//                it is null and the screen says why rather than dividing the
//                fleet's revenue by a number of sites.

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

/**
 * CoinPay commission attributable to one property.
 *
 * Only when the merchant account has exactly one business and it is this one.
 * With several, the snapshot carries a fleet total and no per-business split —
 * `getFinanceAnalytics` takes a `businessId` but the dashboard makes one call,
 * not one per business — so anything else would be the fleet's revenue divided
 * by a guess.
 */
export function coinpayRevenueForSite(
  finance: FinanceInput | null,
  roi: RoiModel,
  site: SiteLike,
): { usd: number | null; basis: string } {
  const businesses = (finance as { businesses?: Array<{ id?: string; name?: string }> } | null)?.businesses ?? [];
  if (!finance) return { usd: null, basis: "no CoinPay session" };
  if (businesses.length !== 1) {
    return {
      usd: null,
      basis: businesses.length
        ? `${businesses.length} CoinPay businesses, no per-business split in the snapshot`
        : "CoinPay reported no businesses",
    };
  }
  const only = businesses[0] as { id?: string; name?: string };
  const name = String(only?.name ?? "");
  if (!(sameProperty(site, name) || site.site.toLowerCase() === name.toLowerCase())) {
    return { usd: null, basis: `all commission belongs to ${name || "another business"}` };
  }
  return { usd: num(roi.revenue.windowUsd), basis: `all CoinPay commission (${name})` };
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
  const costByViews = roi.attention.pageviews > 0 ? costWindow * viewShare : null;
  const costByVisits = roi.attention.visitors > 0 ? costWindow * visitShare : null;

  const ad = adMoneyForSite(input.ads, site);
  const revenue = coinpayRevenueForSite(input.finance, roi, site);
  if (revenue.usd === null) {
    gaps.push(`Revenue is not attributable to one domain here: ${revenue.basis}.`);
  }

  // The earn rail is a network-wide pool — crawler pass revenue funds it with
  // the pass payment's own ref and no project column — so there is no per-domain
  // figure to show. Named rather than omitted, because a missing money line on
  // a money screen reads as a zero.
  gaps.push("Earn-rail rewards are pooled network-wide; there is no per-domain share to report.");

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
        sources: site.sources ?? [],
        revenueUsd: revenue.usd ?? 0,
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
      rpmUsd,
      netUsd: revenue.usd === null || costByViews === null ? null : revenue.usd - costByViews,
    },
    score,
    gaps,
  };
}
