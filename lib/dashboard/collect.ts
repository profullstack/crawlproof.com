// Gathering the three feeds the ROI dashboard joins.
//
// CrawlProof answers per project, so the fleet is a fan-out: one /stats call
// per site, concurrency-capped. That is deliberate rather than a missing
// server-side aggregate — summing 50-odd projects inside one serverless
// request is how the tracker RPCs have timed out before, and a slow client is
// a much better failure than a route that 504s for everybody.
//
// CoinPay is one call into its own SDK, which is the whole point: the finance
// dashboard already exists and this reads it rather than reimplementing it.
//
// Nothing here throws for a partial answer. A source that fails lands in
// `errors` and its panel says so, because a dashboard that hides a dead feed
// behind a zero is worse than one that says the feed is dead.

import {
  buildRoi,
  type AdsInput,
  type FinanceInput,
  type RoiModel,
  type SiteTraffic,
} from "./roi";
import type { ScoreModel } from "./score";
import { buildSiteDetail, type SiteMix, type SitePoint } from "./site";

export type ListItem = { label: string; value: number };

export type SiteStats = SiteTraffic & {
  id?: string;
  url?: string;
  sources: ListItem[];
  referrers: ListItem[];
  pages: ListItem[];
  /** The shape over the window, for the domain screen and the score. */
  series?: SitePoint[];
  /** Humans against bots, unfiltered. Absent when the API did not answer it. */
  mix?: SiteMix;
  /**
   * The risk-to-viral score for this property; see lib/dashboard/score.ts.
   * Attached here so the Traffic list can rank by it without every screen
   * recomputing it, and so `--json` carries it for a script.
   */
  score?: ScoreModel;
};

export type DashboardSnapshot = {
  generatedAt: string;
  window: { range: string; who: string; financeDays: number };
  sites: SiteStats[];
  fleet: { sources: ListItem[]; referrers: ListItem[]; pages: ListItem[] };
  ads: AdsInput | null;
  finance: FinanceInput | null;
  roi: RoiModel;
  /** Source name → why it is missing. Empty when everything answered. */
  errors: Record<string, string>;
};

const TIMEOUT_MS = 20_000;

async function fetchJson<T>(url: string, token: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${res.status} ${res.statusText}: not JSON`);
    }
    if (!res.ok) {
      const message = (body as { error?: string })?.error ?? `${res.status} ${res.statusText}`;
      throw new Error(message);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Run `fn` over `items`, at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Merge per-site lists into one fleet list, largest first. */
export function mergeLists(lists: ListItem[][], limit = 12): ListItem[] {
  const total = new Map<string, number>();
  for (const list of lists) {
    for (const item of list ?? []) {
      const label = String(item?.label ?? "").trim();
      if (!label) continue;
      total.set(label, (total.get(label) ?? 0) + (Number(item?.value) || 0));
    }
  }
  return [...total.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

type SiteRow = { id: string; name: string; url: string; tracker_enabled?: boolean | null };

export async function listSites(baseUrl: string, token: string): Promise<SiteRow[]> {
  const body = await fetchJson<{ sites?: SiteRow[] }>(`${baseUrl}/api/tracker/v1/sites`, token);
  return body.sites ?? [];
}

async function statsForSite(
  baseUrl: string,
  token: string,
  site: SiteRow,
  range: string,
  who: string,
): Promise<SiteStats> {
  // `detail=1` asks for the series and the unfiltered human / bot mix. Both are
  // per-domain questions — the fleet screens need neither — and the mix is the
  // only honest source for "how much of this is a crawler", because a filtered
  // series has a zero bot column by construction.
  const url = `${baseUrl}/api/tracker/v1/stats?site=${encodeURIComponent(site.id)}&range=${encodeURIComponent(range)}&who=${encodeURIComponent(who)}&detail=1`;
  try {
    const body = await fetchJson<{
      totals?: { visitors?: number; pageviews?: number };
      sources?: ListItem[];
      referrers?: ListItem[];
      pages?: ListItem[];
      series?: SitePoint[];
      mix?: SiteMix;
    }>(url, token);
    return {
      site: site.name,
      id: site.id,
      url: site.url,
      visitors: Number(body.totals?.visitors) || 0,
      pageviews: Number(body.totals?.pageviews) || 0,
      sources: body.sources ?? [],
      referrers: body.referrers ?? [],
      pages: body.pages ?? [],
      ...(body.series ? { series: body.series } : {}),
      ...(body.mix ? { mix: body.mix } : {}),
    };
  } catch (err) {
    return {
      site: site.name,
      id: site.id,
      url: site.url,
      visitors: 0,
      pageviews: 0,
      sources: [],
      referrers: [],
      pages: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type CoinPayAuth = { token: string; baseUrl: string };

/**
 * The CoinPay finance snapshot, via CoinPay's own SDK.
 *
 * Imported lazily so that a box without the package — or without a merchant
 * session — still gets a traffic and ads dashboard instead of a stack trace.
 */
export async function collectFinance(
  auth: CoinPayAuth,
  days: number,
): Promise<FinanceInput> {
  const [{ default: CoinPayClient }, finances] = await Promise.all([
    import("@profullstack/coinpay"),
    import("@profullstack/coinpay/finances"),
  ]);
  const client = new CoinPayClient({ apiKey: auth.token, baseUrl: auth.baseUrl });
  // 500 rather than the default page: the vendor breakdown is only honest if
  // the ledger it groups covers the whole window.
  return (await finances.collectFinanceSnapshot(client, { days, limit: 500 })) as FinanceInput;
}

export type CollectOptions = {
  baseUrl: string;
  token: string;
  range: string;
  who: string;
  financeDays: number;
  concurrency?: number;
  coinpay: CoinPayAuth | null;
  /** Limit the fan-out to these site names or ids. */
  only?: string[] | null;
};

export async function collectDashboard(opts: CollectOptions): Promise<DashboardSnapshot> {
  const errors: Record<string, string> = {};

  const sitesPromise = listSites(opts.baseUrl, opts.token).catch((err: unknown) => {
    errors.sites = err instanceof Error ? err.message : String(err);
    return [] as SiteRow[];
  });

  const adsPromise = fetchJson<AdsInput>(
    `${opts.baseUrl}/api/ads/v1/earnings?days=${encodeURIComponent(String(opts.financeDays))}`,
    opts.token,
  ).catch((err: unknown) => {
    errors.ads = err instanceof Error ? err.message : String(err);
    return null;
  });

  const financePromise = opts.coinpay
    ? collectFinance(opts.coinpay, opts.financeDays).catch((err: unknown) => {
        errors.finance = err instanceof Error ? err.message : String(err);
        return null;
      })
    : Promise.resolve(null);
  if (!opts.coinpay) {
    errors.finance = "No CoinPay session. Run `coinpay auth login`, or set COINPAY_SESSION_TOKEN.";
  }

  let siteRows = await sitesPromise;
  if (opts.only?.length) {
    const wanted = new Set(opts.only.map((s) => s.toLowerCase()));
    siteRows = siteRows.filter((s) => wanted.has(s.name.toLowerCase()) || wanted.has(s.id));
  }

  const sites = await mapLimit(siteRows, opts.concurrency ?? 8, (site) =>
    statsForSite(opts.baseUrl, opts.token, site, opts.range, opts.who),
  );
  sites.sort((a, b) => b.visitors - a.visitors || a.site.localeCompare(b.site));

  const failed = sites.filter((s) => s.error).length;
  if (failed) errors.stats = `${failed} of ${sites.length} sites did not answer`;

  const [ads, finance] = await Promise.all([adsPromise, financePromise]);

  const roi = buildRoi({
    traffic: { range: opts.range, who: opts.who, sites },
    ads,
    finance,
  });

  // Scored after the fleet totals exist, because a property's share of the
  // burn is part of what it is being scored on. Pure and cheap: the domain
  // screen rebuilds the whole detail from the same snapshot on demand.
  const window = { range: opts.range, who: opts.who, financeDays: opts.financeDays };
  for (const site of sites) {
    site.score = buildSiteDetail({ site, roi, ads, finance, window }).score;
  }

  return {
    generatedAt: new Date().toISOString(),
    window: { range: opts.range, who: opts.who, financeDays: opts.financeDays },
    sites,
    fleet: {
      sources: mergeLists(sites.map((s) => s.sources)),
      referrers: mergeLists(sites.map((s) => s.referrers)),
      pages: mergeLists(sites.map((s) => s.pages)),
    },
    ads,
    finance,
    roi,
    errors,
  };
}
