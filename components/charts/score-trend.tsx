"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

export type TrendPoint = { date: string; score: number };

export function ScoreTrend({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) {
    return <Empty label="No completed audits yet." />;
  }
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-semibold">Score over time</h3>
        <span className="text-xs text-[var(--color-muted)]">
          {data.length} run{data.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
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
              domain={[0, 100]}
              stroke="var(--color-muted)"
              tick={{ fontSize: 11 }}
              ticks={[0, 25, 50, 75, 100]}
            />
            <ReferenceLine y={80} stroke="var(--color-pass)" strokeDasharray="3 3" />
            <ReferenceLine y={50} stroke="var(--color-warn)" strokeDasharray="3 3" />
            <Tooltip
              contentStyle={{
                background: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(v) => (typeof v === "string" ? new Date(v).toLocaleString() : "")}
              formatter={(value) => [`${value}/100`, "Score"]}
            />
            <Line
              type="monotone"
              dataKey="score"
              stroke="var(--color-accent)"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="card flex h-56 items-center justify-center p-4 text-sm text-[var(--color-muted)]">
      {label}
    </div>
  );
}
