"use client";

import { useEffect, useState, useCallback } from "react";
import { VisitorGlobe } from "./visitor-globe";

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
  lat: number | null;
  lng: number | null;
};

type GlobePoint = { lat: number; lng: number; label: string; age_s: number };

type LiveData = {
  minutes: number;
  total_events: number;
  unique_sessions: number;
  events: LiveEvent[];
  globe_points: GlobePoint[];
  top_pages: { page: string; count: number }[];
  top_sources: { source: string; count: number }[];
  top_countries: { code: string; name: string; count: number }[];
};

const POLL_INTERVAL = 30_000;

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
  const [isDark, setIsDark] = useState(false);

  // Detect dark mode
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setIsDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

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
      // ignore — stale data is fine
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
  const globePoints = data?.globe_points ?? [];

  return (
    <section className="card overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
          </span>
          <h2 className="text-lg font-semibold">Live</h2>
          {lastUpdated && (
            <span className="text-xs text-[var(--color-muted)]">
              · refreshes every 30s · {relTime(lastUpdated.toISOString())}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
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
        <p className="text-sm text-[var(--color-muted)] p-4 pt-0">Loading…</p>
      ) : totalEvents === 0 ? (
        <p className="text-sm text-[var(--color-muted)] p-4 pt-0">
          No events in the last {minutes} minutes. Traffic will appear here as soon as your tracker script fires.
        </p>
      ) : (
        <>
          {/* Globe + summary row */}
          <div className="grid md:grid-cols-[1fr_auto] gap-0">
            {/* Globe */}
            <div className="min-h-[260px] flex items-center justify-center bg-[var(--color-bg-subtle)] dark:bg-slate-900">
              <VisitorGlobe points={globePoints} isDark={isDark} />
            </div>

            {/* Right-side stats */}
            <div className="flex flex-col justify-center gap-4 p-5 border-l border-[var(--color-border)] min-w-[200px]">
              <div className="text-center">
                <p className="text-3xl font-bold text-green-600 tabular-nums">{totalEvents.toLocaleString()}</p>
                <p className="text-xs text-[var(--color-muted)]">events</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-bold tabular-nums">{uniqueSessions.toLocaleString()}</p>
                <p className="text-xs text-[var(--color-muted)]">sessions</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-bold tabular-nums">{globePoints.length.toLocaleString()}</p>
                <p className="text-xs text-[var(--color-muted)]">locations</p>
              </div>
            </div>
          </div>

          {/* Breakdowns */}
          <div className="grid gap-4 sm:grid-cols-3 p-4 border-t border-[var(--color-border)]">
            <div>
              <p className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-2">Top Pages</p>
              <ul className="space-y-1">
                {(data?.top_pages ?? []).slice(0, 7).map(({ page, count }) => (
                  <li key={page} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate font-mono text-xs">{page || "/"}</span>
                    <span className="shrink-0 text-xs text-[var(--color-muted)]">{count}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-2">Sources</p>
              <ul className="space-y-1">
                {(data?.top_sources ?? []).slice(0, 7).map(({ source, count }) => (
                  <li key={source} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{source}</span>
                    <span className="shrink-0 text-xs text-[var(--color-muted)]">{count}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-2">Countries</p>
              <ul className="space-y-1">
                {(data?.top_countries ?? []).slice(0, 7).map(({ code, name, count }) => (
                  <li key={code} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{flagEmoji(code)} {name || code}</span>
                    <span className="shrink-0 text-xs text-[var(--color-muted)]">{count}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Recent event feed */}
          <div className="border-t border-[var(--color-border)]">
            <p className="text-xs font-semibold text-[var(--color-muted)] uppercase tracking-wide px-4 pt-3 pb-2">
              Recent events
            </p>
            <div className="divide-y divide-[var(--color-border)] max-h-52 overflow-y-auto">
              {(data?.events ?? []).slice(0, 50).map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-2 px-4 py-1.5 text-xs hover:bg-[var(--color-bg-subtle)]"
                >
                  <span className="shrink-0 text-[var(--color-muted)] w-14 text-right tabular-nums">
                    {relTime(e.occurred_at)}
                  </span>
                  <span className="shrink-0 font-mono bg-[var(--color-bg-subtle)] px-1 rounded text-[10px]">
                    {e.event}
                  </span>
                  <span className="truncate font-mono">{e.page_path || "/"}</span>
                  {(e.city || e.country_code) && (
                    <span className="shrink-0 text-[var(--color-muted)]">
                      {flagEmoji(e.country_code)}{e.city ? ` ${e.city}` : ""}
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
