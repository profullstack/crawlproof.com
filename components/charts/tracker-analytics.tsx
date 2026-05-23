"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type TrackerDailyPoint = {
  date: string;
  events: number;
  pageviews: number;
  interactions: number;
  ai: number;
  bots: number;
};

export type TrackerListItem = {
  label: string;
  value: number;
};

const COLORS = [
  "var(--color-accent)",
  "#60a5fa",
  "var(--color-warn)",
  "#f472b6",
  "#a78bfa",
  "#2dd4bf",
];

export function TrackerAnalytics({
  daily,
  events,
  sources,
  pages,
  referrers,
  actions,
}: {
  daily: TrackerDailyPoint[];
  events: TrackerListItem[];
  sources: TrackerListItem[];
  pages: TrackerListItem[];
  referrers: TrackerListItem[];
  actions: TrackerListItem[];
}) {
  const total = daily.reduce((sum, point) => sum + point.events, 0);

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Traffic pulse</h2>
            <p className="text-sm text-[var(--color-muted)]">
              Pageviews, interactions, AI referrals, and bot crawls.
            </p>
          </div>
          <span className="text-xs text-[var(--color-muted)]">
            {total.toLocaleString()} events
          </span>
        </div>
        <div className="h-72 min-h-72 min-w-0">
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            minHeight={288}
            initialDimension={{ width: 640, height: 288 }}
          >
            <AreaChart
              data={daily}
              margin={{ top: 8, right: 16, bottom: 0, left: -20 }}
            >
              <CartesianGrid
                stroke="var(--color-border)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="date"
                stroke="var(--color-muted)"
                tick={{ fontSize: 11 }}
                tickFormatter={formatDate}
              />
              <YAxis stroke="var(--color-muted)" tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={formatLongDate} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area
                type="monotone"
                dataKey="pageviews"
                name="Pageviews"
                stackId="1"
                stroke="var(--color-accent)"
                fill="var(--color-accent)"
                fillOpacity={0.28}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="interactions"
                name="Interactions"
                stackId="1"
                stroke="#60a5fa"
                fill="#60a5fa"
                fillOpacity={0.22}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="ai"
                name="AI referrals"
                stroke="var(--color-pass)"
                fill="var(--color-pass)"
                fillOpacity={0.16}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="bots"
                name="Bot crawls"
                stroke="var(--color-warn)"
                fill="var(--color-warn)"
                fillOpacity={0.14}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown title="Event mix" data={events} />
        <Breakdown title="Top sources" data={sources} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankedList title="Top pages" data={pages} empty="No page paths yet." />
        <RankedList
          title="Top interactions"
          data={actions}
          empty="No click or form interactions yet."
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankedList
          title="Referrer hosts"
          data={referrers}
          empty="No external referrers yet."
        />
      </div>
    </div>
  );
}

function Breakdown({ title, data }: { title: string; data: TrackerListItem[] }) {
  const total = data.reduce((sum, row) => sum + row.value, 0);

  if (!total) {
    return (
      <section className="card flex h-72 items-center justify-center p-4 text-sm text-[var(--color-muted)]">
        No data yet.
      </section>
    );
  }

  return (
    <section className="card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-xs text-[var(--color-muted)]">
          {total.toLocaleString()} total
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
        <div className="h-48 min-h-48 min-w-0">
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            minHeight={192}
            initialDimension={{ width: 180, height: 192 }}
          >
            <PieChart>
              <Pie
                data={data.slice(0, 6)}
                dataKey="value"
                nameKey="label"
                innerRadius={42}
                outerRadius={72}
                paddingAngle={2}
                isAnimationActive={false}
              >
                {data.slice(0, 6).map((entry, index) => (
                  <Cell
                    key={entry.label}
                    fill={COLORS[index % COLORS.length]}
                    stroke="var(--color-card)"
                  />
                ))}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <RankRows data={data} total={total} />
      </div>
    </section>
  );
}

function RankedList({
  title,
  data,
  empty,
}: {
  title: string;
  data: TrackerListItem[];
  empty: string;
}) {
  const total = data.reduce((sum, row) => sum + row.value, 0);

  return (
    <section className="card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-xs text-[var(--color-muted)]">
          {total.toLocaleString()} total
        </span>
      </div>
      {total ? (
        <>
          <div className="mb-4 h-44 min-h-44 min-w-0">
            <ResponsiveContainer
              width="100%"
              height="100%"
              minWidth={0}
              minHeight={176}
              initialDimension={{ width: 420, height: 176 }}
            >
              <BarChart
                data={data.slice(0, 6)}
                layout="vertical"
                margin={{ top: 0, right: 12, bottom: 0, left: 8 }}
              >
                <CartesianGrid
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                  horizontal={false}
                />
                <XAxis type="number" stroke="var(--color-muted)" tick={{ fontSize: 11 }} />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={92}
                  stroke="var(--color-muted)"
                  tick={{ fontSize: 11 }}
                  tickFormatter={shortLabel}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="value" name="Events" fill="var(--color-accent)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <RankRows data={data} total={total} />
        </>
      ) : (
        <p className="text-sm text-[var(--color-muted)]">{empty}</p>
      )}
    </section>
  );
}

function RankRows({ data, total }: { data: TrackerListItem[]; total: number }) {
  return (
    <div className="space-y-2">
      {data.slice(0, 8).map((row, index) => {
        const share = total ? (row.value / total) * 100 : 0;
        return (
          <div key={row.label} className="grid grid-cols-[1fr_auto] gap-3 text-sm">
            <div className="min-w-0">
              <div className="truncate text-[var(--color-fg)]">{row.label}</div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(2, share)}%`,
                    background: COLORS[index % COLORS.length],
                  }}
                />
              </div>
            </div>
            <div className="text-right tabular-nums">
              <div>{row.value.toLocaleString()}</div>
              <div className="text-xs text-[var(--color-muted)]">
                {share.toFixed(1)}%
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const tooltipStyle = {
  background: "var(--color-card)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatLongDate(value: unknown) {
  return new Date(String(value)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function shortLabel(value: string) {
  return value.length > 18 ? `${value.slice(0, 17)}...` : value;
}
