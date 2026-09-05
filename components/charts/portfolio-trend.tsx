"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// One stacked band per property, so the total height is the portfolio's
// human traffic and each band shows which site is actually moving it. Series
// keys are project ids (plus the synthetic OTHER_KEY band) because project
// names are not unique.
//
// Bot crawls are NOT part of the stack. They are drawn as one dashed, unfilled
// overlay line (BOTS_KEY) so a crawler storm is visible without swamping the
// human bands it used to be summed into.
export type PortfolioSeries = {
  key: string;
  name: string;
  /** "band" (default) stacks; "overlay" draws an unstacked line on top. */
  kind?: "band" | "overlay";
};

export type PortfolioPoint = { date: string } & Record<string, number | string>;

export const OTHER_KEY = "__other";
export const BOTS_KEY = "__bots";

const COLORS = [
  "var(--color-accent)",
  "#60a5fa",
  "var(--color-warn)",
  "#f472b6",
  "#a78bfa",
  "#2dd4bf",
];

const OTHER_COLOR = "var(--color-muted)";
const OVERLAY_COLOR = "var(--color-muted)";

export function PortfolioTrend({
  data,
  series,
}: {
  data: PortfolioPoint[];
  series: PortfolioSeries[];
}) {
  const bands = series.filter((entry) => entry.kind !== "overlay");
  const overlays = series.filter((entry) => entry.kind === "overlay");

  return (
    <div className="h-72 min-h-72 min-w-0">
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        minHeight={288}
        initialDimension={{ width: 640, height: 288 }}
      >
        <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -20 }}>
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
          {bands.map((entry, index) => {
            const color =
              entry.key === OTHER_KEY
                ? OTHER_COLOR
                : COLORS[index % COLORS.length];
            return (
              <Area
                key={entry.key}
                type="monotone"
                dataKey={entry.key}
                name={entry.name}
                stackId="portfolio"
                stroke={color}
                fill={color}
                fillOpacity={entry.key === OTHER_KEY ? 0.14 : 0.26}
                isAnimationActive={false}
              />
            );
          })}
          {overlays.map((entry) => (
            <Area
              key={entry.key}
              type="monotone"
              dataKey={entry.key}
              name={entry.name}
              stroke={OVERLAY_COLOR}
              strokeDasharray="4 3"
              fill={OVERLAY_COLOR}
              fillOpacity={0}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
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
