"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CampaignDailyPoint } from "@/lib/ads/series";

export function CampaignTrend({ data }: { data: CampaignDailyPoint[] }) {
  const total = data.reduce((sum, p) => sum + p.impressions + p.clicks, 0);
  if (total === 0) {
    return (
      <div className="card flex h-64 items-center justify-center p-4 text-sm text-[var(--color-muted)]">
        No impressions or clicks recorded yet.
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Performance over time</h2>
        <span className="text-xs text-[var(--color-muted)]">Last {data.length} days</span>
      </div>
      <div className="h-64 min-h-64 min-w-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={256}
          initialDimension={{ width: 640, height: 256 }}
        >
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              stroke="var(--color-muted)"
              tick={{ fontSize: 11 }}
              tickFormatter={(v: string) =>
                new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })
              }
            />
            <YAxis
              yAxisId="impressions"
              allowDecimals={false}
              stroke="var(--color-muted)"
              tick={{ fontSize: 11 }}
            />
            <YAxis
              yAxisId="clicks"
              orientation="right"
              allowDecimals={false}
              stroke="var(--color-muted)"
              tick={{ fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{
                background: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(v) =>
                typeof v === "string" ? new Date(v).toLocaleDateString() : ""
              }
            />
            <Line
              yAxisId="impressions"
              type="monotone"
              dataKey="impressions"
              name="Impressions"
              stroke="var(--color-accent)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            <Line
              yAxisId="clicks"
              type="monotone"
              dataKey="clicks"
              name="Clicks"
              stroke="var(--color-warn)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
        <span>
          <span className="mr-1 inline-block size-2 rounded-full bg-[var(--color-accent)]" />
          Impressions (left)
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-full bg-[var(--color-warn)]" />
          Clicks (right)
        </span>
      </div>
    </div>
  );
}
