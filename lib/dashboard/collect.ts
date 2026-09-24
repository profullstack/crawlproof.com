// Gathering the three feeds the ROI dashboard joins.
//
// CrawlProof answers per project, so the fleet is a fan-out: one /stats call
// per site, concurrency-capped. That is deliberate rather than a missing
// server-side aggregate — summing 50-odd projects inside one serverless
// request is how the tracker RPCs have timed out before, and a slow client is
// a much better failure than a route that 504s for everybody.
//
// CoinPay's SDK supplies the fleet snapshot and business-specific analytics
// for the domain view. The latter use a bounded fan-out too.
//
// Nothing here throws for a partial answer. A source that fails lands in
// `errors` and its panel says so, because a dashboard that hides a dead feed
// behind a zero is worse than one that says the feed is dead.

import {
  buildRoi,
  type AdsInput,
  type BusinessRevenue,
  type FinanceInput,
  type RoiModel,
  type SiteTraffic,
} from "./roi";
import type { ScoreModel } from "./score";
import { buildSiteDetail, type SiteMix, type SitePoint } from "./site";

export type ListItem = { label: string; value: number };
export type FeedName = "traffic" | "ads" | "finance";
export type FeedProgress = {
  status: "idle" | "loading" | "retrying" | "success" | "error";
  detail: string;
};
export type ProgressListener = (feed: FeedName, progress: FeedProgress) => void;

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
  /** Last successful ads read; retained across a transient failure in the same window. */
  adsUpdatedAt?: string;
  adsStale?: boolean;
  finance: FinanceInput | null;
  roi: RoiModel;
  /** Source name → why it is missing. Empty when everything answered. */
  errors: Record<string, string>;
};

const TIMEOUT_MS = 20_000;
export const ADS_TIMEOUT_MS = 60_000;

class FeedError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

async function fetchJson<T>(url: string, token: string, timeoutMs = TIMEOUT_MS, method: "GET" | "POST" = "GET"): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new FeedError(`${res.status} ${res.statusText}: not JSON`, res.status >= 500);
    }
    if (!res.ok) {
      const message = (body as { error?: string })?.error ?? `${res.status} ${res.statusText}`;
      throw new FeedError(message, res.status === 408 || res.status === 429 || res.status >= 500);
    }
    return body as T;
  } catch (err) {
    if (controller.signal.aborted) throw new FeedError(`Request timed out after ${timeoutMs / 1000}s`, true);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** One project's email tracking, as GET /api/v1/email-tracking answers it. */
export type EmailTrackingRow = {
  project_id: string;
  site: string;
  role: string;
  tracking_id: string;
  enabled: boolean;
  events_24h?: { open: number; click: number; unsubscribe: number };
};

/** Every project's email tracking, for the TUI's Email tab. */
export async function listEmailTracking(baseUrl: string, token: string): Promise<EmailTrackingRow[]> {
  const body = await fetchJson<{ projects?: EmailTrackingRow[] }>(`${baseUrl.replace(/\/$/, "")}/api/v1/email-tracking`, token);
  return body.projects ?? [];
}

/** Turn one project's email tracking on or off. */
export async function setEmailTracking(baseUrl: string, token: string, projectId: string, on: boolean): Promise<EmailTrackingRow> {
  const path = `/api/v1/email-tracking/${encodeURIComponent(projectId)}/${on ? "enable" : "disable"}`;
  return fetchJson<EmailTrackingRow>(`${baseUrl.replace(/\/$/, "")}${path}`, token, TIMEOUT_MS, "POST");
}

/** Ads aggregate hundreds of campaigns. Retry one transient or partial read. */
export async function collectAds(baseUrl: string, token: string, days: number, progress?: (value: FeedProgress) => void): Promise<AdsInput> {
  const url = `${baseUrl}/api/ads/v1/earnings?days=${encodeURIComponent(String(days))}`;
  let partial: AdsInput | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    progress?.({ status: attempt ? "retrying" : "loading", detail: attempt ? "Ads retry 2/2" : "Fetching ads" });
    try {
      const ads = await fetchJson<AdsInput>(url, token, ADS_TIMEOUT_MS);
      if (!ads.statsUnavailable) return ads;
      partial = ads;
      progress?.({ status: "retrying", detail: "Ads incomplete; retrying" });
    } catch (err) {
      const retryable = err instanceof FeedError ? err.retryable : err instanceof TypeError;
      if (!retryable) throw err;
      if (attempt === 1) {
        if (partial) return partial;
        throw err;
      }
      progress?.({ status: "retrying", detail: "Ads request failed; retrying" });
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return partial as AdsInput;
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

/** Keep each business separate, including failures, so no fleet total leaks into a domain. */
export async function collectBusinessRevenue(
  businesses: NonNullable<FinanceInput["businesses"]>,
  days: number,
  analyticsFor: (businessId: string) => Promise<Record<string, unknown>>,
  progress?: (completed: number, total: number) => void,
): Promise<Record<string, BusinessRevenue>> {
  const ids = [...new Set(businesses.flatMap((b) => b.id ? [b.id] : []))];
  let completed = 0;
  progress?.(completed, ids.length);
  const entries = await mapLimit(ids, 4, async (id): Promise<[string, BusinessRevenue]> => {
    try {
      const analytics = await analyticsFor(id);
      const series = analytics?.series as { points?: Array<Record<string, unknown>> } | undefined;
      if (!Array.isArray(series?.points)) throw new Error("CoinPay returned no windowed series");
      const totals = { commissionUsd: 0, grossVolumeUsd: 0, transactions: 0 };
      for (const point of series.points) {
        for (const [key, field] of [
          ["commissionUsd", "total_commission_usd"],
          ["grossVolumeUsd", "total_volume_usd"],
          ["transactions", "total_count"],
        ] as const) {
          const value = point?.[field];
          if (value == null || value === "" || !Number.isFinite(Number(value))) {
            throw new Error("CoinPay returned incomplete windowed analytics");
          }
          totals[key] += Number(value);
        }
      }
      return [id, { windowDays: days, ...totals }];
    } catch (err) {
      return [id, { windowDays: days, error: err instanceof Error ? err.message : String(err) }];
    } finally {
      progress?.(++completed, ids.length);
    }
  });
  return Object.fromEntries(entries);
}

/**
 * The CoinPay finance snapshot, via CoinPay's own SDK.
 *
 * Imported lazily so that a box without the package — or without a merchant
 * session — still gets a traffic and ads dashboard instead of a stack trace.
 */
export async function collectFinance(
  auth: CoinPayAuth,
  days: number,
  progress?: (value: FeedProgress) => void,
): Promise<FinanceInput> {
  progress?.({ status: "loading", detail: "CoinPay bank & payments" });
  const [{ default: CoinPayClient }, finances] = await Promise.all([
    import("@profullstack/coinpay"),
    import("@profullstack/coinpay/finances"),
  ]);
  const client = new CoinPayClient({ apiKey: auth.token, baseUrl: auth.baseUrl });
  // 500 rather than the default page: the vendor breakdown is only honest if
  // the ledger it groups covers the whole window.
  const snapshot = await finances.collectFinanceSnapshot(client, { days, limit: 500 });
  // CoinPay's route accepts day/week/month/year, while this SDK's periodForDays
  // emits 7d/30d, which the route treats as all-time. Use the server's presets.
  const period = days <= 1 ? "day" : days <= 7 ? "week" : days <= 30 ? "month" : "year";
  const windowDays = days <= 1 ? 1 : days <= 7 ? 7 : days <= 30 ? 30 : 365;
  const businessRevenue = await collectBusinessRevenue(snapshot.businesses, windowDays, (businessId) =>
    finances.getFinanceAnalytics(client, { period, businessId }),
    (completed, total) => progress?.({ status: "loading", detail: `CoinPay businesses ${completed}/${total}` }),
  );
  return { ...snapshot, businessRevenue } as FinanceInput;
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
  /** Preserve a successful ads read if this refresh fails in the same finance window. */
  previous?: DashboardSnapshot | null;
  onProgress?: ProgressListener;
};

export async function collectDashboard(opts: CollectOptions): Promise<DashboardSnapshot> {
  const errors: Record<string, string> = {};
  const report = (feed: FeedName, status: FeedProgress["status"], detail: string) => opts.onProgress?.(feed, { status, detail });
  report("traffic", "loading", "Listing domains");

  const sitesPromise = listSites(opts.baseUrl, opts.token).catch((err: unknown) => {
    errors.sites = err instanceof Error ? err.message : String(err);
    return [] as SiteRow[];
  });

  const adsPromise = collectAds(opts.baseUrl, opts.token, opts.financeDays, (p) => opts.onProgress?.("ads", p)).then((ads) => {
    report("ads", ads.statsUnavailable ? "error" : "success", ads.statsUnavailable ? "Ads partially loaded" : "Ads refreshed");
    return ads;
  }).catch((err: unknown) => {
    errors.ads = err instanceof Error ? err.message : String(err);
    report("ads", "error", `Ads failed: ${errors.ads}`);
    return null;
  });

  const financePromise = opts.coinpay
    ? collectFinance(opts.coinpay, opts.financeDays, (p) => opts.onProgress?.("finance", p)).then((finance) => {
        const failures = Object.keys(finance.errors ?? {}).length + Object.values(finance.businessRevenue ?? {}).filter((b) => b.error).length;
        if (failures) errors.finance = `${failures} CoinPay sources unavailable`;
        report("finance", failures ? "error" : "success", failures ? errors.finance! : "CoinPay refreshed");
        return finance;
      }).catch((err: unknown) => {
        errors.finance = err instanceof Error ? err.message : String(err);
        report("finance", "error", `CoinPay failed: ${errors.finance}`);
        return null;
      })
    : Promise.resolve(null);
  if (!opts.coinpay) {
    errors.finance = "No CoinPay session. Run `coinpay auth login`, or set COINPAY_SESSION_TOKEN.";
    report("finance", "error", "CoinPay: no session");
  }

  let siteRows = await sitesPromise;
  if (opts.only?.length) {
    const wanted = new Set(opts.only.map((s) => s.toLowerCase()));
    siteRows = siteRows.filter((s) => wanted.has(s.name.toLowerCase()) || wanted.has(s.id));
  }

  let completed = 0;
  report("traffic", "loading", `Traffic ${completed}/${siteRows.length}`);
  const sites = await mapLimit(siteRows, opts.concurrency ?? 8, async (site) => {
    const stats = await statsForSite(opts.baseUrl, opts.token, site, opts.range, opts.who);
    report("traffic", "loading", `Traffic ${++completed}/${siteRows.length}`);
    return stats;
  });
  sites.sort((a, b) => b.visitors - a.visitors || a.site.localeCompare(b.site));

  const failed = sites.filter((s) => s.error).length;
  if (failed) errors.stats = `${failed} of ${sites.length} sites did not answer`;
  report("traffic", failed || errors.sites ? "error" : "success", errors.sites ? "Domain list failed" : failed ? `Traffic: ${failed} sites failed` : `Traffic ${sites.length}/${sites.length} refreshed`);

  const [fetchedAds, finance] = await Promise.all([adsPromise, financePromise]);
  let ads = fetchedAds;
  if (ads?.statsUnavailable) errors.ads = "Some ad queries failed; domain ad money and delivery are unavailable.";
  let adsUpdatedAt = ads ? new Date().toISOString() : undefined;
  let adsStale = false;
  const previous = opts.previous;
  if ((!ads || ads.statsUnavailable) && previous?.ads && !previous.ads.statsUnavailable && previous.window.financeDays === opts.financeDays) {
    ads = previous.ads;
    adsUpdatedAt = previous.adsUpdatedAt ?? previous.generatedAt;
    adsStale = true;
    report("ads", "error", "Ads failed; showing saved data");
  }

  const roi = buildRoi({
    traffic: { range: opts.range, who: opts.who, sites },
    ads,
    finance,
  });

  // Scored after the finance data arrives so money can contribute when it is
  // attributable. The domain screen rebuilds the same detail on demand.
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
    adsUpdatedAt,
    adsStale,
    finance,
    roi,
    errors,
  };
}
