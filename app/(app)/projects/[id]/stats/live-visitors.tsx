"use client";

import { useEffect, useState, useCallback } from "react";
import { VisitorGlobe, type GlobePoint } from "./visitor-globe";
import { LiveChart } from "./live-chart";

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

// GlobePoint imported from visitor-globe

type LiveData = {
  minutes: number;
  total_events: number;
  unique_sessions: number;
  events: LiveEvent[];
  globe_points: (GlobePoint & { visitor_id: string })[];
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
  const [view, setView] = useState<"globe" | "chart">("globe");

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
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
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
        <div className="flex items-center gap-2">
          {/* Globe | Chart tab switch */}
          <div className="inline-flex overflow-hidden rounded border border-[var(--color-border)]">
            {(["globe", "chart"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-2 py-0.5 text-xs capitalize transition-colors ${
                  view === v
                    ? "bg-[var(--color-primary)] text-white"
                    : "text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                }`}
              >
                {v}
              </button>
            ))}
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
      </div>

      {loading ? (
        <p className="text-xs text-[var(--color-muted)] px-3 pb-2">Loading…</p>
      ) : totalEvents === 0 ? (
        <p className="text-xs text-[var(--color-muted)] px-3 pb-2">
          No events in the last {minutes} min. Traffic will appear once the tracker script fires.
        </p>
      ) : (
        <>
          {view === "chart" ? (
            <LiveChart events={data?.events ?? []} minutes={minutes} />
          ) : (
          /* Globe left + stats right */
          <div className="flex items-center gap-0">
            {/* Globe — 50% of card width, click to toggle spin */}
            <div className="w-1/2 shrink-0 bg-[var(--color-bg-subtle)] dark:bg-slate-900">
              <VisitorGlobe points={globePoints} isDark={isDark} />
            </div>

            {/* Right column: numbers + breakdowns */}
            <div className="flex-1 min-w-0 px-3 py-2 space-y-3 border-l border-[var(--color-border)]">
              {/* Summary pills */}
              <div className="flex flex-wrap gap-3">
                <div>
                  <p className="text-lg font-bold text-green-600 tabular-nums leading-none">{totalEvents.toLocaleString()}</p>
                  <p className="text-[10px] text-[var(--color-muted)]">events</p>
                </div>
                <div>
                  <p className="text-lg font-bold tabular-nums leading-none">{uniqueSessions.toLocaleString()}</p>
                  <p className="text-[10px] text-[var(--color-muted)]">sessions</p>
                </div>
                <div>
                  <p className="text-lg font-bold tabular-nums leading-none">{globePoints.length}</p>
                  <p className="text-[10px] text-[var(--color-muted)]">visitors on map</p>
                </div>
              </div>

              {/* Top pages */}
              <div>
                <p className="text-[10px] font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-1">Top Pages</p>
                <ul className="space-y-0.5">
                  {(data?.top_pages ?? []).slice(0, 5).map(({ page, count }) => (
                    <li key={page} className="flex items-center justify-between gap-1 text-xs">
                      <span className="truncate font-mono text-[10px]">{page || "/"}</span>
                      <span className="shrink-0 text-[10px] text-[var(--color-muted)]">{count}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Top countries */}
              <div>
                <p className="text-[10px] font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-1">Countries</p>
                <ul className="space-y-0.5">
                  {(data?.top_countries ?? []).slice(0, 5).map(({ code, name, count }) => (
                    <li key={code} className="flex items-center justify-between gap-1 text-xs">
                      <span className="truncate text-[10px]">{flagEmoji(code)} {name || code}</span>
                      <span className="shrink-0 text-[10px] text-[var(--color-muted)]">{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
          )}

          {/* Recent event feed */}
          <div className="border-t border-[var(--color-border)]">
            <div className="divide-y divide-[var(--color-border)] max-h-40 overflow-y-auto">
              {(data?.events ?? []).slice(0, 40).map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-1.5 px-3 py-1 text-[10px] hover:bg-[var(--color-bg-subtle)]"
                >
                  <span className="shrink-0 text-[var(--color-muted)] w-12 text-right tabular-nums">
                    {relTime(e.occurred_at)}
                  </span>
                  <span className="shrink-0 font-mono bg-[var(--color-bg-subtle)] px-1 rounded text-[9px]">
                    {e.event}
                  </span>
                  <span className="truncate font-mono">{e.page_path || "/"}</span>
                  {e.country_code && (
                    <span className="shrink-0 text-[var(--color-muted)]">
                      {flagEmoji(e.country_code)}{e.city ? ` ${e.city}` : ""}
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
