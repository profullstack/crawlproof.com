// Live view of the feed crawler, modelled on rssamplifier.com/crawlstats.
//
// The autoblog cites real posts from RSS Amplifier topic feeds, and until the
// crawl was daemonized that source was invisible: a topic going missing looked
// identical to a topic nobody had configured. This is where that difference
// becomes visible.
//
// Deliberately read-only and unconfigurable. The feed list is derived from
// every active site's master keywords on each sweep, so there is nothing here
// to add or remove — a subject added to a blog appears within a tick. An
// "add a feed" button would imply a curation step that does not exist, and
// would create a queue of requests waiting for a human, which is the thing
// the automation is meant to remove.

import { serviceClient } from "@/lib/supabase/service";
import { ago, loadCrawlerStats } from "@/lib/lx/feedCrawlStats";

// Always fresh: a status page served from a cache reports the cache's health,
// not the crawler's, and would go on saying "healthy" through an outage.
export const dynamic = "force-dynamic";

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="card p-4">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </div>
      {note ? (
        <div className="mt-1 text-xs text-[var(--color-muted)]">{note}</div>
      ) : null}
    </div>
  );
}

export default async function CrawlerStatusPage() {
  const { stats, sources } = await loadCrawlerStats(serviceClient());
  const now = Date.now();

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-bold">Crawler status</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Live view of the daemon that reads the RSS Amplifier topic feeds the
        autoblog cites from. The feed list is derived from every active
        site&apos;s master keywords — nothing here is curated by hand. The same
        numbers are available as{" "}
        <a className="underline" href="/api/lx/feed-crawl/status">
          JSON
        </a>
        .
      </p>

      {stats.stalled ? (
        <div className="mt-4 rounded border border-[var(--color-danger,#b91c1c)] p-3 text-sm">
          <strong>Stalled.</strong> {stats.dueNow.toLocaleString()} feed(s) are
          due and nothing has been read successfully since{" "}
          {ago(stats.lastSuccessAt, now)}. Either the worker is not running or
          the directory is unreachable — this page cannot tell which, and the
          two have different fixes.
        </div>
      ) : null}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Feeds"
          value={stats.sources.toLocaleString()}
          note={`${stats.active.toLocaleString()} active`}
        />
        <Stat
          label="Due now"
          value={stats.dueNow.toLocaleString()}
          note="waiting to be crawled"
        />
        <Stat
          label="Cached posts"
          value={stats.items.toLocaleString()}
          note={`${stats.newItems24h.toLocaleString()} new in 24h`}
        />
        <Stat
          label="Erroring"
          value={stats.erroring.toLocaleString()}
          note={`${stats.gaveUp.toLocaleString()} given up`}
        />
      </div>

      <p className="mt-3 text-xs text-[var(--color-muted)]">
        Last successful fetch {ago(stats.lastSuccessAt, now)} ·{" "}
        {stats.neverFetched.toLocaleString()} never fetched · generated{" "}
        {stats.generatedAt}
      </p>

      <h2 className="mt-8 text-xl font-semibold">Feeds</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        One row per subject any active blog covers. A feed is re-read at most
        every 6 hours, least-recently-fetched first, 25 per sweep — so the work
        per tick is fixed however many subjects the platform grows to.
      </p>

      {sources.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-muted)]">
          No feeds yet. The first sweep derives them from the active sites&apos;
          master keywords; if this stays empty, no site has master keywords set.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-[var(--color-muted)]">
                <th className="py-2 pr-4">Topic</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Last read</th>
                <th className="py-2 pr-4">Last success</th>
                <th className="py-2 pr-4 text-right">Items</th>
                <th className="py-2">Last error</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr
                  key={source.id}
                  className="border-t border-[var(--color-border,#2a2a2a)]"
                >
                  <td className="py-2 pr-4">
                    <a className="underline" href={source.url} rel="noopener">
                      {source.topic}
                    </a>
                  </td>
                  <td className="py-2 pr-4">
                    {source.status === "given_up" ? (
                      <span
                        title={`${source.consecutive_failures} consecutive failures`}
                      >
                        given up
                      </span>
                    ) : source.consecutive_failures > 0 ? (
                      <span>failing ({source.consecutive_failures})</span>
                    ) : (
                      <span>active</span>
                    )}
                  </td>
                  <td className="py-2 pr-4">{ago(source.last_fetch_at, now)}</td>
                  <td className="py-2 pr-4">
                    {ago(source.last_success_at, now)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {source.item_count.toLocaleString()}
                  </td>
                  <td className="py-2 text-xs text-[var(--color-muted)]">
                    {source.last_error ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
