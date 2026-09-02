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
import { formatBucket, type RangeDef } from "@/lib/ads/ranges";
import type { AccountPoint } from "@/lib/ads/series";

/**
 * Account-wide delivery over the selected range.
 *
 * Impressions only, split paid vs free — one measure, one unit, one axis.
 * Clicks and spend live in the stat tiles above rather than as extra lines here:
 * clicks run ~1% of impressions and spend is money, so putting either on this
 * plot would mean a second y-scale, and a dual-axis chart invites exactly the
 * false correlations it appears to show.
 *
 * Stacked, because paid + free is a meaningful total (every ad actually shown)
 * and the split is the point — free backfill is delivery that earns nobody
 * anything, and it should be visible as a share of the whole.
 */
export function AccountTrend({
  data,
  range,
  failed = false,
}: {
  data: AccountPoint[];
  range: RangeDef;
  failed?: boolean;
}) {
  const total = data.reduce((n, p) => n + p.impressions + p.freeImpressions + p.clicks, 0);

  // A failed series arrives zero-filled and so is indistinguishable from a quiet
  // range by its values alone. Saying "No delivery" here would be a statement of
  // fact about the network, made from a query that never returned -- the same
  // mistake #226 fixed for the tiles, still being made by the chart underneath
  // them, and directly contradicting the banner the page renders above.
  if (failed) {
    return (
      <div className="card flex h-64 items-center justify-center p-4 text-center text-sm text-[var(--color-muted)]">
        Couldn&apos;t load this chart. It isn&apos;t empty — the query didn&apos;t
        return. Reloading often fixes it.
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="card flex h-64 items-center justify-center p-4 text-sm text-[var(--color-muted)]">
        No delivery in this range.
      </div>
    );
  }

  const hasFree = data.some((p) => p.freeImpressions > 0);

  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Delivery over time</h2>
        <span className="text-xs text-[var(--color-muted)]">{range.hint}</span>
      </div>
      <div className="h-64 min-h-64 min-w-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={256}
          initialDimension={{ width: 640, height: 256 }}
        >
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              stroke="var(--color-muted)"
              tick={{ fontSize: 11 }}
              minTickGap={28}
              tickFormatter={(v: number) => formatBucket(v, range.tick)}
            />
            <YAxis
              allowDecimals={false}
              stroke="var(--color-muted)"
              tick={{ fontSize: 11 }}
              width={48}
            />
            <Tooltip
              // Crosshair: readers aim at a time, not at a 2px line.
              cursor={{ stroke: "var(--color-muted)", strokeWidth: 1, strokeDasharray: "3 3" }}
              contentStyle={{
                background: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--color-fg)",
              }}
              labelStyle={{ color: "var(--color-muted)", marginBottom: 4 }}
              labelFormatter={(v) => formatBucket(Number(v), range.tick)}
              formatter={(value, name) => [Number(value).toLocaleString(), String(name)]}
            />
            {/* Legend only once there are two series to tell apart — with a
                single series the heading already names it. */}
            {hasFree && <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />}
            <Area
              type="monotone"
              dataKey="impressions"
              name="Paid"
              stackId="impressions"
              stroke="var(--color-chart-1)"
              strokeWidth={2}
              fill="var(--color-chart-1)"
              fillOpacity={0.22}
            />
            {hasFree && (
              <Area
                type="monotone"
                dataKey="freeImpressions"
                name="Free backfill"
                stackId="impressions"
                stroke="var(--color-chart-2)"
                strokeWidth={2}
                fill="var(--color-chart-2)"
                fillOpacity={0.22}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
