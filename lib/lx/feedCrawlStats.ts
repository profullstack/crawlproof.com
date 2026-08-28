// The numbers behind the crawler status page.
//
// Kept out of the page so the HTML view and the JSON endpoint cannot drift —
// a status page and a machine-readable feed of the same status that disagree
// are worse than having only one of them.

import type { SupabaseClient } from "@supabase/supabase-js";
import { REFRESH_AFTER_MS } from "./feedCrawl";

export type FeedSourceRow = {
  id: string;
  topic: string;
  url: string;
  status: string;
  last_fetch_at: string | null;
  last_success_at: string | null;
  last_status: number | null;
  last_error: string | null;
  item_count: number;
  consecutive_failures: number;
};

export type CrawlerStats = {
  sources: number;
  active: number;
  gaveUp: number;
  dueNow: number;
  neverFetched: number;
  erroring: number;
  items: number;
  newItems24h: number;
  lastSuccessAt: string | null;
  /**
   * The daemon looks stopped.
   *
   * Sources are due and nothing has succeeded in a while. Stated as a
   * suspicion rather than a fact because this cannot distinguish "the worker
   * is down" from "the directory is down" — and the operator's next step
   * differs, so claiming to know which would send them the wrong way.
   */
  stalled: boolean;
  generatedAt: string;
};

/** Nothing succeeded in this long, with work waiting, reads as stalled. */
const STALL_AFTER_MS = 2 * 60 * 60 * 1000; // 2h — four missed 30-min ticks

export async function loadCrawlerStats(
  supabase: SupabaseClient<any>,
): Promise<{ stats: CrawlerStats; sources: FeedSourceRow[] }> {
  const now = Date.now();
  const dueBefore = new Date(now - REFRESH_AFTER_MS).toISOString();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const [{ data: sources }, itemCount, new24h] = await Promise.all([
    supabase
      .from("lx_feed_source")
      .select(
        "id, topic, url, status, last_fetch_at, last_success_at, last_status, last_error, item_count, consecutive_failures",
      )
      .order("last_fetch_at", { ascending: true, nullsFirst: true })
      .limit(500),
    supabase
      .from("lx_feed_item")
      .select("id", { count: "exact", head: true })
      .then((r) => r.count ?? 0),
    supabase
      .from("lx_feed_item")
      .select("id", { count: "exact", head: true })
      .gte("first_seen_at", since24h)
      .then((r) => r.count ?? 0),
  ]);

  const rows = (sources ?? []) as FeedSourceRow[];
  const active = rows.filter((r) => r.status === "active");
  const dueNow = active.filter(
    (r) => !r.last_fetch_at || r.last_fetch_at < dueBefore,
  ).length;

  const lastSuccessAt = rows
    .map((r) => r.last_success_at)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1) ?? null;

  const stalled =
    dueNow > 0 &&
    (!lastSuccessAt || now - Date.parse(lastSuccessAt) > STALL_AFTER_MS);

  return {
    stats: {
      sources: rows.length,
      active: active.length,
      gaveUp: rows.filter((r) => r.status === "given_up").length,
      dueNow,
      neverFetched: rows.filter((r) => !r.last_fetch_at).length,
      erroring: rows.filter((r) => r.consecutive_failures > 0).length,
      items: itemCount,
      newItems24h: new24h,
      lastSuccessAt,
      stalled,
      generatedAt: new Date(now).toISOString(),
    },
    sources: rows,
  };
}

/** "15m ago", "3h ago", "never" — the only formatting this page needs. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
