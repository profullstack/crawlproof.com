"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { bucketLabel } from "@/lib/tracker/categorize";

export type LiveChartEvent = {
  id: number;
  occurred_at: string;
  event: string;
  page_path: string;
  referrer_host: string;
  bucket: string;
  country_code: string;
  country_name: string;
};

// One line on the chart. `key` is the recharts dataKey and is prefixed by
// group id so labels from different dimensions never collide.
type Series = { key: string; label: string; color: string; total: number };
type Group = { id: string; label: string; series: Series[] };

// Number of time buckets across the window, and the cap on how many lines a
// single group may contribute — keeps a busy site from drawing hundreds of
// lines at once.
const BUCKETS = 30;
const MAX_PER_GROUP = 8;

// The special "all events" line lives under the Traffic group.
const TOTAL_KEY = "traffic::__total__";

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function colorFor(key: string): string {
  if (key === TOTAL_KEY) return "var(--color-accent)";
  const h = hashCode(key);
  return `hsl(${h % 360}, 70%, 55%)`;
}

function eventLabel(event: string) {
  return event
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

type BuiltChart = {
  data: Array<Record<string, number | string>>;
  groups: Group[];
  seriesByKey: Map<string, Series>;
};

// Bucket the raw events into a time series, one accumulator per dimension
// value. Recomputed every poll so the chart tracks live traffic.
function buildChart(events: LiveChartEvent[], minutes: number): BuiltChart {
  const now = Date.now();
  const windowMs = minutes * 60 * 1000;
  const start = now - windowMs;
  const bucketMs = windowMs / BUCKETS;

  // group id → series key → count[BUCKETS]
  const dims: Record<string, Map<string, { label: string; counts: number[] }>> = {
    traffic: new Map(),
    src: new Map(),
    page: new Map(),
    geo: new Map(),
  };

  const bump = (dim: string, key: string, label: string, idx: number) => {
    const m = dims[dim];
    let entry = m.get(key);
    if (!entry) {
      entry = { label, counts: new Array(BUCKETS).fill(0) };
      m.set(key, entry);
    }
    entry.counts[idx] += 1;
  };

  for (const e of events) {
    const t = new Date(e.occurred_at).getTime();
    if (Number.isNaN(t) || t < start) continue;
    const idx = Math.min(BUCKETS - 1, Math.max(0, Math.floor((t - start) / bucketMs)));

    // Traffic: a total line + one line per event type.
    bump("traffic", TOTAL_KEY, "Total", idx);
    bump("traffic", `evt::${e.event}`, eventLabel(e.event || "pageview"), idx);

    // Sources (categorized referrer bucket).
    const src = bucketLabel(e.bucket) || "Direct";
    bump("src", `src::${src}`, src, idx);

    // Pages.
    const page = e.page_path || "/";
    bump("page", `page::${page}`, page, idx);

    // Countries.
    if (e.country_code) {
      const name = e.country_name || e.country_code;
      bump("geo", `geo::${e.country_code}`, name, idx);
    }
  }

  const seriesByKey = new Map<string, Series>();
  const toGroup = (id: string, label: string, keepAll = false): Group => {
    const entries = Array.from(dims[id].entries()).map(([key, v]) => {
      const total = v.counts.reduce((a, b) => a + b, 0);
      return { key, label: v.label, color: colorFor(key), total };
    });
    entries.sort((a, b) => b.total - a.total);
    const kept = keepAll ? entries : entries.slice(0, MAX_PER_GROUP);
    for (const s of kept) seriesByKey.set(s.key, s);
    return { id, label, series: kept };
  };

  // Traffic keeps its Total line pinned first, then top event types.
  const trafficEntries = Array.from(dims.traffic.entries()).map(([key, v]) => {
    const total = v.counts.reduce((a, b) => a + b, 0);
    return { key, label: v.label, color: colorFor(key), total };
  });
  trafficEntries.sort((a, b) => {
    if (a.key === TOTAL_KEY) return -1;
    if (b.key === TOTAL_KEY) return 1;
    return b.total - a.total;
  });
  const trafficKept = trafficEntries.slice(0, MAX_PER_GROUP + 1);
  for (const s of trafficKept) seriesByKey.set(s.key, s);

  const groups: Group[] = [
    { id: "traffic", label: "Traffic", series: trafficKept },
    toGroup("src", "Sources"),
    toGroup("page", "Pages"),
    toGroup("geo", "Countries"),
  ];

  // Assemble the recharts rows. Every kept series gets a value on every row so
  // recharts keeps a continuous line.
  const data: Array<Record<string, number | string>> = [];
  for (let i = 0; i < BUCKETS; i++) {
    const t = start + i * bucketMs + bucketMs / 2;
    const d = new Date(t);
    const row: Record<string, number | string> = {
      time: d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        ...(minutes <= 10 ? { second: "2-digit" } : {}),
      }),
    };
    for (const [key] of seriesByKey) {
      const dim = key.split("::", 1)[0];
      row[key] = dims[dim]?.get(key)?.counts[i] ?? 0;
    }
    data.push(row);
  }

  return { data, groups, seriesByKey };
}

export function LiveChart({
  events,
  minutes,
}: {
  events: LiveChartEvent[];
  minutes: number;
}) {
  const { data, groups, seriesByKey } = useMemo(
    () => buildChart(events, minutes),
    [events, minutes],
  );

  // Which lines are drawn. Default to just the Total line so the chart starts
  // legible; the viewer opts extra series in.
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set([TOTAL_KEY]),
  );
  // Collapsed legend groups.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggleSeries = (key: string) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleGroup = (group: Group) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      const allOn = group.series.every((s) => next.has(s.key));
      for (const s of group.series) {
        if (allOn) next.delete(s.key);
        else next.add(s.key);
      }
      return next;
    });

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const activeKeys = Array.from(seriesByKey.keys()).filter((k) => enabled.has(k));

  return (
    <div className="flex flex-col gap-0 lg:flex-row">
      {/* Chart */}
      <div className="min-w-0 flex-1 px-3 py-2">
        <div className="h-64 min-h-64 min-w-0">
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            minHeight={256}
            initialDimension={{ width: 320, height: 256 }}
          >
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
              <CartesianGrid
                stroke="var(--color-border)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="time"
                stroke="var(--color-muted)"
                tick={{ fontSize: 10 }}
                interval={Math.floor(BUCKETS / 6)}
                minTickGap={16}
              />
              <YAxis
                allowDecimals={false}
                stroke="var(--color-muted)"
                tick={{ fontSize: 10 }}
                width={40}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                itemSorter={(item) => -(item.value as number)}
              />
              {activeKeys.map((key) => {
                const s = seriesByKey.get(key)!;
                return (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={key === TOTAL_KEY ? 2.5 : 1.5}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                    connectNulls
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        </div>
        {activeKeys.length === 0 && (
          <p className="text-center text-[10px] text-[var(--color-muted)]">
            No lines selected — pick some labels on the right.
          </p>
        )}
      </div>

      {/* Grouped, toggleable label picker */}
      <div className="w-full shrink-0 border-t border-[var(--color-border)] px-3 py-2 lg:max-h-64 lg:w-56 lg:overflow-y-auto lg:border-l lg:border-t-0">
        <div className="mb-1 flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Labels
          </p>
          <button
            onClick={() => setEnabled(new Set())}
            className="text-[10px] text-[var(--color-muted)] underline hover:text-[var(--color-foreground)]"
          >
            clear
          </button>
        </div>
        <div className="space-y-2">
          {groups.map((group) => {
            if (group.series.length === 0) return null;
            const allOn = group.series.every((s) => enabled.has(s.key));
            const someOn = group.series.some((s) => enabled.has(s.key));
            const isCollapsed = collapsed.has(group.id);
            return (
              <div key={group.id}>
                <div className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={allOn}
                    ref={(el) => {
                      if (el) el.indeterminate = someOn && !allOn;
                    }}
                    onChange={() => toggleGroup(group)}
                    className="h-3 w-3 shrink-0 cursor-pointer accent-[var(--color-accent)]"
                  />
                  <button
                    onClick={() => toggleCollapse(group.id)}
                    className="flex flex-1 items-center gap-1 text-left text-[11px] font-semibold text-[var(--color-foreground)]"
                  >
                    <span className="text-[8px] text-[var(--color-muted)]">
                      {isCollapsed ? "▶" : "▼"}
                    </span>
                    {group.label}
                    <span className="text-[9px] font-normal text-[var(--color-muted)]">
                      ({group.series.length})
                    </span>
                  </button>
                </div>
                {!isCollapsed && (
                  <ul className="ml-4 mt-0.5 space-y-0.5">
                    {group.series.map((s) => (
                      <li key={s.key}>
                        <label className="flex cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={enabled.has(s.key)}
                            onChange={() => toggleSeries(s.key)}
                            className="h-3 w-3 shrink-0 cursor-pointer accent-[var(--color-accent)]"
                          />
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: s.color }}
                          />
                          <span className="truncate text-[10px]" title={s.label}>
                            {s.label}
                          </span>
                          <span className="ml-auto shrink-0 text-[9px] tabular-nums text-[var(--color-muted)]">
                            {s.total}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
