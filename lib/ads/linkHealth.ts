// Ad link health: keep the live list free of campaigns whose page is gone.
//
// The worker runs runAdLinkHealthSweep on a clock. Each tick fetches the
// destination_url of the campaigns checked longest ago and records what came
// back on the campaign row. A campaign whose page is dead on two checks at
// least DEAD_GRACE_MS apart is paused with paused_reason 'dead_link'; one the
// sweep paused is re-activated as soon as its page answers again. A campaign
// the advertiser paused by hand is never touched (paused_reason is cleared by a
// trigger on any other status change; see the migration).
//
// Only an unambiguous answer counts as dead: 404, 410, or a host that no longer
// resolves. Everything else, a 402 crawl gate, a 403/999 bot wall, a 429, a
// 5xx, a timeout, is "unknown" and changes nothing. The measured mix on
// 2026-10-19 (979 distinct live destinations) was mostly 200 plus several
// hundred 402s from our own fleet's crawl gate, which answers 402 to any IP
// past 100 requests a minute. That is why requests to one host are spaced
// HOST_GAP_MS apart: a fast sweep would read the whole fleet as "unknown".

import type { SupabaseClient } from "@supabase/supabase-js";

export const LINK_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEAD_GRACE_MS = 12 * 60 * 60 * 1000;
export const DEAD_CHECKS_TO_PAUSE = 2;
export const HOST_GAP_MS = 2_000;
export const HOST_CONCURRENCY = 6;
export const FETCH_TIMEOUT_MS = 15_000;
export const SWEEP_BATCH = 400;
export const LINK_CHECK_UA = "CrawlProof-AdLinkCheck/1.0 (+https://crawlproof.com/bot)";
export const DEAD_LINK_REASON = "dead_link";

export type LinkVerdict = "ok" | "dead" | "unknown";
export type LinkProbe = { verdict: LinkVerdict; httpStatus: number | null; error: string | null };

type CampaignRow = {
  id: string;
  destination_url: string;
  status: string;
  paused_reason: string | null;
  link_dead_since: string | null;
  link_dead_checks: number | null;
};

/** Pure: what an HTTP status (or a fetch error code) says about the page. */
export function classifyLink(httpStatus: number | null, errorCode?: string | null): LinkVerdict {
  if (httpStatus != null) {
    if (httpStatus >= 200 && httpStatus < 400) return "ok";
    if (httpStatus === 404 || httpStatus === 410) return "dead";
    return "unknown";
  }
  // NXDOMAIN: the domain itself is gone. A refused or reset connection, a TLS
  // failure or a timeout is as likely to be our network as theirs.
  if (errorCode === "ENOTFOUND") return "dead";
  return "unknown";
}

/** Can this URL be checked from here at all? Tor and non-http links cannot. */
export function isCheckable(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return !u.hostname.endsWith(".onion");
  } catch {
    return false;
  }
}

/** Pure: what the sweep does to a campaign after a probe. */
export function nextLinkState(
  c: Pick<CampaignRow, "status" | "paused_reason" | "link_dead_since" | "link_dead_checks">,
  probe: LinkProbe,
  now: number,
): {
  link_status: LinkVerdict;
  link_dead_since: string | null;
  link_dead_checks: number;
  action: "pause" | "resume" | null;
} {
  const pausedByUs = c.status === "paused" && c.paused_reason === DEAD_LINK_REASON;
  if (probe.verdict === "ok") {
    return { link_status: "ok", link_dead_since: null, link_dead_checks: 0, action: pausedByUs ? "resume" : null };
  }
  if (probe.verdict === "unknown") {
    return {
      link_status: "unknown",
      link_dead_since: c.link_dead_since,
      link_dead_checks: c.link_dead_checks ?? 0,
      action: null,
    };
  }
  const since = c.link_dead_since ?? new Date(now).toISOString();
  const checks = (c.link_dead_checks ?? 0) + 1;
  const serving = c.status === "active" || c.status === "exhausted";
  const longEnough = now - Date.parse(since) >= DEAD_GRACE_MS;
  return {
    link_status: "dead",
    link_dead_since: since,
    link_dead_checks: checks,
    action: serving && checks >= DEAD_CHECKS_TO_PAUSE && longEnough ? "pause" : null,
  };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Fetch one destination and classify it. Never throws. */
export async function probeLink(url: string, fetchImpl: FetchLike = fetch): Promise<LinkProbe> {
  if (!isCheckable(url)) return { verdict: "unknown", httpStatus: null, error: "uncheckable" };
  const headers: Record<string, string> = { "user-agent": LINK_CHECK_UA, accept: "text/html,*/*;q=0.8" };
  // A Profullstack Power Key gets through every fleet site's crawl gate
  // regardless of the per-IP quota. Optional: without it 402s read as unknown.
  const powerKey = process.env.PFS_POWER_KEY;
  if (powerKey) headers["x-power-key"] = powerKey;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    return { verdict: classifyLink(res.status), httpStatus: res.status, error: null };
  } catch (e) {
    const err = e as { name?: string; code?: string; cause?: { code?: string } };
    const code = err.cause?.code ?? err.code ?? err.name ?? "fetch_failed";
    return { verdict: classifyLink(null, code), httpStatus: null, error: String(code).slice(0, 80) };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Probe each distinct URL once: hosts in parallel (HOST_CONCURRENCY), each
 * host's URLs one at a time HOST_GAP_MS apart.
 */
export async function probeAll(
  urls: string[],
  opts: {
    fetchImpl?: FetchLike;
    gapMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Called as each URL is answered, so results land before the batch ends. */
    onProbe?: (url: string, probe: LinkProbe) => Promise<void>;
  } = {},
): Promise<Map<string, LinkProbe>> {
  const gap = opts.gapMs ?? HOST_GAP_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const byHost = new Map<string, string[]>();
  for (const u of new Set(urls)) {
    const h = hostOf(u);
    byHost.set(h, [...(byHost.get(h) ?? []), u]);
  }
  const out = new Map<string, LinkProbe>();
  const queue = [...byHost.values()];
  const lane = async () => {
    for (let list = queue.shift(); list; list = queue.shift()) {
      for (let i = 0; i < list.length; i++) {
        if (i > 0 && gap > 0) await sleep(gap);
        const probe = await probeLink(list[i], opts.fetchImpl);
        out.set(list[i], probe);
        await opts.onProbe?.(list[i], probe);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HOST_CONCURRENCY, queue.length) }, lane));
  return out;
}

export type LinkSweepResult = {
  checked: number;
  ok: number;
  dead: number;
  unknown: number;
  paused: string[];
  resumed: string[];
  failed?: string;
};

/** One tick: check the stalest batch, record results, pause dead, resume recovered. */
export async function runAdLinkHealthSweep(
  sb: SupabaseClient,
  opts: { now?: number; batch?: number; fetchImpl?: FetchLike; gapMs?: number; dryRun?: boolean } = {},
): Promise<LinkSweepResult> {
  const now = opts.now ?? Date.now();
  const result: LinkSweepResult = { checked: 0, ok: 0, dead: 0, unknown: 0, paused: [], resumed: [] };
  const staleBefore = new Date(now - LINK_CHECK_INTERVAL_MS).toISOString();

  const batch = opts.batch ?? SWEEP_BATCH;
  const stale = () =>
    sb
      .from("ad_campaigns")
      .select("id, destination_url, status, paused_reason, link_dead_since, link_dead_checks")
      .or(`link_checked_at.is.null,link_checked_at.lt.${staleBefore}`)
      .order("link_checked_at", { ascending: true, nullsFirst: true })
      .limit(batch);
  // Serving campaigns, plus the ones this sweep paused (to resume them). A
  // campaign paused by hand is not ours to check or resume.
  const [live, ours] = await Promise.all([
    stale().in("status", ["active", "exhausted"]),
    stale().eq("status", "paused").eq("paused_reason", DEAD_LINK_REASON),
  ]);
  const error = live.error ?? ours.error;
  if (error) return { ...result, failed: error.message };
  const rows = [...((ours.data ?? []) as CampaignRow[]), ...((live.data ?? []) as CampaignRow[])].slice(0, batch);
  if (!rows.length) return result;

  const checkedAt = new Date(now).toISOString();
  const byUrl = new Map<string, CampaignRow[]>();
  for (const r of rows) byUrl.set(r.destination_url, [...(byUrl.get(r.destination_url) ?? []), r]);

  // Each URL's campaigns are written the moment it is answered. A full batch
  // takes minutes (same-host requests are spaced out), and a redeploy that
  // restarts the worker mid-batch must not throw away what was already checked.
  await probeAll([...byUrl.keys()], {
    fetchImpl: opts.fetchImpl,
    gapMs: opts.gapMs,
    onProbe: async (url, probe) => {
      for (const row of byUrl.get(url) ?? []) await record(row, probe);
    },
  });
  return result;

  async function record(row: CampaignRow, probe: LinkProbe) {
    const next = nextLinkState(row, probe, now);
    result.checked++;
    result[next.link_status]++;

    const update: Record<string, unknown> = {
      link_status: next.link_status,
      link_http_status: probe.httpStatus,
      link_error: probe.error,
      link_checked_at: checkedAt,
      link_dead_since: next.link_dead_since,
      link_dead_checks: next.link_dead_checks,
    };
    if (next.action === "pause") {
      update.status = "paused";
      update.paused_reason = DEAD_LINK_REASON;
      result.paused.push(row.id);
    } else if (next.action === "resume") {
      update.status = "active";
      update.paused_reason = null;
      result.resumed.push(row.id);
    }
    if (opts.dryRun) return;

    // Guard the status flip on the status we read, so a campaign the
    // advertiser changed mid-sweep keeps their change.
    const { error: upErr } = await sb.from("ad_campaigns").update(update).eq("id", row.id).eq("status", row.status);
    if (upErr) result.failed = upErr.message;
  }
}
