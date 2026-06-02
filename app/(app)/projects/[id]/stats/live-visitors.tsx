"use client";

import { useEffect, useState, useCallback } from "react";

type LiveEvent = {
  id: number;
  occurred_at: string;
  event: string;
  page_path: string;
  referrer_host: string;
  event_target: string;
  bucket: string;
  country_code: string;
  country_name: string;
  city: string;
};

type TopItem = { page?: string; source?: string; code?: string; name?: string; count: number };

type LiveData = {
  minutes: number;
  total_events: number;
  unique_sessions: number;
  events: LiveEvent[];
  top_pages: { page: string; count: number }[];
  top_sources: { source: string; count: number }[];
  top_countries: { code: string; name: string; count: number }[];
};

const POLL_INTERVAL = 30_000; // 30 seconds

function relTime(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function flagEmoji(code: string) {
  if (!code || code.length !== 2) return "";
  return String.fromCodePoint(
    ...code.toUpperCase().split("").map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

export function LiveVisitors({ projectId }: { projectId: string }) {
  const [data, setData] = useState<LiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [minutes, setMinutes] = useState(30);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/projects/${projectId}/live-events?minutes=${minutes}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const json = await res.json();
      setData(json);
      setLastUpdated(new Date());
    } catch {
      // silently ignore fetch errors — stale data is fine
    } finally {
      setLoading(false);
    }
  }, [projectId, minutes]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchData]);

  const totalEvents = data?.total_events ?? 0;
  const uniqueSessions = data?.unique_sessions ?? 0;

  return (
    <section className="card p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
          </span>
          <h2 className="text-lg font-semibold">Live</h2>
          {lastUpdated && (
            <span className="text-xs text-[var(--color-muted)]">
              updated {relTime(lastUpdated.toISOString())}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--color-muted)]">Window:</span>
          {([5, 15, 30, 60] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMinutes(m)}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                minutes === m
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                  : "border-[var(--color-border)] hover:border-[var(--color-primary)] text-[var(--color-muted)]"
              }`}
            >
              {m}m
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--color-muted)]">Loading…</p>
      ) : totalEvents === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          No events in the last {minutes} minutes.
        </p>
      ) : (
        <>
          {/* Summary metrics */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-[var(--color-border)] p-3 text-center">
              <p className="text-2xl font-bold text-green-600">{totalEvents.toLocaleString()}</p>
              <p className="text-xs text-[var(--color-muted)] mt-0.5">events</p>
            </div>
            <div className="rounded-md border border-[var(--color-border)] p-3 text-center">
              <p className="text-2xl font-bold">{uniqueSessions.toLocaleString()}</p>
              <p className="text-xs text-[var(--color-muted)] mt-0.5">sessions</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {/* Top pages */}
            <div>
              <p className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-2">
                Pages
              </p>
              <ul className="space-y-1">
                {(data?.top_pages ?? []).slice(0, 8).map(({ page, count }) => (
                  <li key={page} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate font-mono text-xs">{page || "/"}</span>
                    <span className="shrink-0 text-xs text-[var(--color-muted)]">{count}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Top sources */}
            <div>
              <p className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-2">
                Sources
              </p>
              <ul className="space-y-1">
                {(data?.top_sources ?? []).slice(0, 8).map(({ source, count }) => (
                  <li key={source} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{source}</span>
                    <span className="shrink-0 text-xs text-[var(--color-muted)]">{count}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Top countries */}
            <div>
              <p className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-2">
                Countries
              </p>
              <ul className="space-y-1">
                {(data?.top_countries ?? []).slice(0, 8).map(({ code, name, count }) => (
                  <li key={code} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">
                      {flagEmoji(code)} {name || code}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--color-muted)]">{count}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Recent event feed */}
          <div>
            <p className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-2">
              Recent events
            </p>
            <div className="rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)] max-h-64 overflow-y-auto">
              {(data?.events ?? []).slice(0, 50).map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--color-bg-subtle)]"
                >
                  <span className="shrink-0 text-[var(--color-muted)] w-14 text-right">
                    {relTime(e.occurred_at)}
                  </span>
                  <span className="shrink-0 font-mono bg-[var(--color-bg-subtle)] px-1 rounded text-[10px]">
                    {e.event}
                  </span>
                  <span className="truncate font-mono">{e.page_path || "/"}</span>
                  {e.country_code && (
                    <span className="shrink-0 text-[var(--color-muted)]">
                      {flagEmoji(e.country_code)}
                      {e.city ? ` ${e.city}` : ""}
                    </span>
                  )}
                  {e.referrer_host && (
                    <span className="shrink-0 text-[var(--color-muted)] hidden sm:inline">
                      ← {e.referrer_host}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
