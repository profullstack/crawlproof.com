"use client";

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";

export type StatusCounts = { pass: number; warn: number; fail: number; unknown: number };

const COLORS: Record<keyof StatusCounts, string> = {
  pass: "var(--color-pass)",
  warn: "var(--color-warn)",
  fail: "var(--color-fail)",
  unknown: "var(--color-unknown)",
};

const LABELS: Record<keyof StatusCounts, string> = {
  pass: "Pass",
  warn: "Warn",
  fail: "Fail",
  unknown: "Unknown",
};

export function StatusPie({ counts }: { counts: StatusCounts }) {
  const data = (Object.keys(counts) as (keyof StatusCounts)[])
    .map((k) => ({ name: LABELS[k], key: k, value: counts[k] }))
    .filter((d) => d.value > 0);
  const total = data.reduce((s, d) => s + d.value, 0);

  if (total === 0) {
    return (
      <div className="card flex h-56 items-center justify-center p-4 text-sm text-[var(--color-muted)]">
        No findings yet.
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-semibold">Findings by status</h3>
        <span className="text-xs text-[var(--color-muted)]">{total} total</span>
      </div>
      <div className="h-56 min-h-56 min-w-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={224}
          initialDimension={{ width: 320, height: 224 }}
        >
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={45}
              outerRadius={80}
              paddingAngle={2}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={d.key} fill={COLORS[d.key]} stroke="var(--color-card)" />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value, name) => [`${value}`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
