"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MoneyDailyPoint } from "@/lib/ads/earnings-data";

// Spend vs. earnings over time, in dollars. Mirrors the styling of
// CampaignTrend but plots money on a single $ axis. Loaded via next/dynamic
// (ssr:false) so recharts stays out of the server bundle.
export function MoneyTrend({ data }: { data: MoneyDailyPoint[] }) {
  const total = data.reduce((s, p) => s + p.spentCents + p.earnedCents, 0);
  if (total === 0) {
    return (
      <div className="card flex h-64 items-center justify-center p-4 text-sm text-[var(--color-muted)]">
        No spend or earnings recorded yet.
      </div>
    );
  }

  const chartData = data.map((p) => ({
    date: p.date,
    spent: p.spentCents / 100,
    earned: p.earnedCents / 100,
  }));

  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Spend &amp; earnings over time</h2>
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
          <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
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
              stroke="var(--color-muted)"
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) => `$${v}`}
              width={48}
            />
            <Tooltip
              contentStyle={{
                background: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              // recharts' Formatter type is awkward; loosen it (see repo's other charts).
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={((v: any, name: any) => [`$${Number(v).toFixed(2)}`, name]) as any}
              labelFormatter={(v) => (typeof v === "string" ? new Date(v).toLocaleDateString() : "")}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="earned"
              name="Earnings"
              stroke="var(--color-accent)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey="spent"
              name="Spend"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
