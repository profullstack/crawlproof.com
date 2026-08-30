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
import { TimeframeTabs } from "./timeframe-tabs";
import { usePanelRange } from "./use-panel-range";
import {
  DEFAULT_TRACKER_RANGE,
  trackerRange,
  type TrackerRange,
  type TrackerRangeKey,
} from "@/lib/tracker/ranges";
import type { ListItem, SeriesPayload } from "@/lib/tracker/panels";

export type TrackerDailyPoint = {
  date: string;
  events: number;
  pageviews: number;
  interactions: number;
  ai: number;
  bots: number;
};

export type TrackerListItem = ListItem;

// Every panel the page server-renders, keyed the same way the API route keys
// its response so a tab switch can swap one in place.
export type TrackerPanels = {
  series: SeriesPayload;
  events: ListItem[];
  sources: ListItem[];
  pages: ListItem[];
  exitPages: ListItem[];
  referrers: ListItem[];
  actions: ListItem[];
  countries: ListItem[];
  cities: ListItem[];
  devices: ListItem[];
  browsers: ListItem[];
  operatingSystems: ListItem[];
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
  projectId,
  initial,
  initialRange = DEFAULT_TRACKER_RANGE,
}: {
  /** Omitted by the portfolio page, which has no single-project endpoint. */
  projectId?: string;
  initial: TrackerPanels;
  initialRange?: TrackerRangeKey;
}) {
  const common = { projectId, initialRange };

  return (
    <div className="space-y-4">
      <TrafficPulse {...common} initialData={initial.series} />

      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownPanel
          {...common}
          panel="events"
          title="Event mix"
          initialData={initial.events}
        />
        <BreakdownPanel
          {...common}
          panel="sources"
          title="Top sources"
          initialData={initial.sources}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankedPanel
          {...common}
          panel="pages"
          title="Top pages"
          empty="No page paths yet."
          initialData={initial.pages}
        />
        <RankedPanel
          {...common}
          panel="exitPages"
          title="Exit pages"
          empty="No exit pages yet."
          initialData={initial.exitPages}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankedPanel
          {...common}
          panel="actions"
          title="Top interactions"
          empty="No click or form interactions yet."
          initialData={initial.actions}
        />
        <RankedPanel
          {...common}
          panel="referrers"
          title="Referrer hosts"
          empty="No external referrers yet."
          initialData={initial.referrers}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankedPanel
          {...common}
          panel="countries"
          title="Countries"
          empty="No location data yet."
          initialData={initial.countries}
        />
        <RankedPanel
          {...common}
          panel="cities"
          title="Cities"
          empty="No city data yet."
          initialData={initial.cities}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownPanel
          {...common}
          panel="devices"
          title="Devices"
          initialData={initial.devices}
        />
        <RankedPanel
          {...common}
          panel="browsers"
          title="Browsers"
          empty="No browser data yet."
          initialData={initial.browsers}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankedPanel
          {...common}
          panel="operatingSystems"
          title="Operating systems"
          empty="No OS data yet."
          initialData={initial.operatingSystems}
        />
      </div>
    </div>
  );
}

// Shared card chrome: title, the timeframe tabs, a right-hand total, and the
// loading / error treatment. The body stays mounted and dims while a range
// loads — swapping it for a spinner makes every tab click flash the card and
// loses the shape the reader is comparing against.
function PanelFrame({
  title,
  subtitle,
  total,
  ranges,
  range,
  onRange,
  showTabs,
  loading,
  error,
  children,
  className = "card p-4",
}: {
  title: string;
  subtitle?: string;
  total?: number;
  ranges: TrackerRange[];
  range: TrackerRangeKey;
  onRange: (key: TrackerRangeKey) => void;
  showTabs: boolean;
  loading: boolean;
  error: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{title}</h2>
          {subtitle && (
            <p className="text-sm text-[var(--color-muted)]">{subtitle}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-[var(--color-muted)]">
            {error
              ? "—"
              : total === undefined
                ? ""
                : `${total.toLocaleString()} ${total === 1 ? "event" : "events"}`}
          </span>
          {showTabs && (
            <TimeframeTabs
              ranges={ranges}
              value={range}
              onChange={onRange}
              label={`${title} timeframe`}
            />
          )}
        </div>
      </div>
      {error ? (
        <p className="text-sm text-[var(--color-warn)]">
          Could not load this timeframe: {error}
        </p>
      ) : (
        <div
          aria-busy={loading}
          className={loading ? "opacity-50 transition-opacity" : undefined}
        >
          {children}
        </div>
      )}
    </section>
  );
}

function TrafficPulse({
  projectId,
  initialData,
  initialRange,
}: {
  projectId?: string;
  initialData: SeriesPayload;
  initialRange: TrackerRangeKey;
}) {
  const { ranges, range, setRange, data, loading, error, showTabs } =
    usePanelRange<SeriesPayload>(
      projectId,
      "series",
      initialData,
      initialRange,
    );

  const points = data?.points ?? [];
  const total = points.reduce((sum, point) => sum + point.events, 0);
  const byTime = data?.granularity === "time";

  return (
    <PanelFrame
      title="Traffic pulse"
      subtitle="Pageviews, interactions, AI referrals, and bot crawls."
      total={total}
      ranges={ranges}
      range={range}
      onRange={setRange}
      showTabs={showTabs}
      loading={loading}
      error={error}
    >
      <div className="h-72 min-h-72 min-w-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={288}
          initialDimension={{ width: 640, height: 288 }}
        >
          <AreaChart
            data={points}
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
              tickFormatter={byTime ? formatTime : formatDate}
              minTickGap={24}
            />
            <YAxis stroke="var(--color-muted)" tick={{ fontSize: 11 }} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={byTime ? formatLongTime : formatLongDate}
            />
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
    </PanelFrame>
  );
}

function BreakdownPanel({
  projectId,
  panel,
  title,
  initialData,
  initialRange,
}: {
  projectId?: string;
  panel: string;
  title: string;
  initialData: ListItem[];
  initialRange: TrackerRangeKey;
}) {
  const { ranges, range, setRange, data, loading, error, showTabs } =
    usePanelRange<ListItem[]>(projectId, panel, initialData, initialRange);

  const rows = data ?? [];
  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <PanelFrame
      title={title}
      total={total}
      ranges={ranges}
      range={range}
      onRange={setRange}
      showTabs={showTabs}
      loading={loading}
      error={error}
    >
      {total ? (
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
                  data={rows.slice(0, 6)}
                  dataKey="value"
                  nameKey="label"
                  innerRadius={42}
                  outerRadius={72}
                  paddingAngle={2}
                  isAnimationActive={false}
                >
                  {rows.slice(0, 6).map((entry, index) => (
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
          <RankRows data={rows} total={total} />
        </div>
      ) : (
        <EmptyRange message="No data in this timeframe." range={range} />
      )}
    </PanelFrame>
  );
}

function RankedPanel({
  projectId,
  panel,
  title,
  empty,
  initialData,
  initialRange,
}: {
  projectId?: string;
  panel: string;
  title: string;
  empty: string;
  initialData: ListItem[];
  initialRange: TrackerRangeKey;
}) {
  const { ranges, range, setRange, data, loading, error, showTabs } =
    usePanelRange<ListItem[]>(projectId, panel, initialData, initialRange);

  const rows = data ?? [];
  const total = rows.reduce((sum, row) => sum + row.value, 0);

  return (
    <PanelFrame
      title={title}
      total={total}
      ranges={ranges}
      range={range}
      onRange={setRange}
      showTabs={showTabs}
      loading={loading}
      error={error}
    >
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
                data={rows.slice(0, 6)}
                layout="vertical"
                margin={{ top: 0, right: 12, bottom: 0, left: 8 }}
              >
                <CartesianGrid
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  stroke="var(--color-muted)"
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={92}
                  stroke="var(--color-muted)"
                  tick={{ fontSize: 11 }}
                  tickFormatter={shortLabel}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar
                  dataKey="value"
                  name="Events"
                  fill="var(--color-accent)"
                  radius={[0, 4, 4, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <RankRows data={rows} total={total} />
        </>
      ) : (
        <EmptyRange message={empty} range={range} />
      )}
    </PanelFrame>
  );
}

// An empty panel at 1H usually means "quiet hour", not "never tracked" — say
// which, so a reader narrowing the window does not read it as data loss.
function EmptyRange({
  message,
  range,
}: {
  message: string;
  range: TrackerRangeKey;
}) {
  return (
    <p className="text-sm text-[var(--color-muted)]">
      {message}{" "}
      <span className="text-xs">
        ({trackerRange(range).description.toLowerCase()})
      </span>
    </p>
  );
}

function RankRows({ data, total }: { data: ListItem[]; total: number }) {
  return (
    <div className="space-y-2">
      {data.slice(0, 8).map((row, index) => {
        const share = total ? (row.value / total) * 100 : 0;
        return (
          <div
            key={row.label}
            className="grid grid-cols-[1fr_auto] gap-3 text-sm"
          >
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

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatLongTime(value: unknown) {
  return new Date(String(value)).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shortLabel(value: string) {
  return value.length > 18 ? `${value.slice(0, 17)}...` : value;
}
