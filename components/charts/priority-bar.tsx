"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from "recharts";

export type PriorityCounts = { p1: number; p2: number; p3: number; p4: number; p5: number };

const COLOR_BY_P: Record<number, string> = {
  1: "var(--color-fail)",
  2: "var(--color-fail)",
  3: "var(--color-warn)",
  4: "var(--color-warn)",
  5: "var(--color-pass)",
};

export function PriorityBar({ counts }: { counts: PriorityCounts }) {
  const data = [1, 2, 3, 4, 5].map((p) => ({
    priority: `P${p}`,
    count: counts[`p${p}` as keyof PriorityCounts] ?? 0,
    p,
  }));
  const total = data.reduce((s, d) => s + d.count, 0);

  if (total === 0) {
    return (
      <div className="card flex h-56 items-center justify-center p-4 text-sm text-[var(--color-muted)]">
        No outstanding work.
      </div>
    );
  }

  return (
    <div className="card p-4">
      <h3 className="mb-2 font-semibold">Open issues by priority</h3>
      <div className="h-56 min-h-56 min-w-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={224}
          initialDimension={{ width: 320, height: 224 }}
        >
          <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="priority" stroke="var(--color-muted)" tick={{ fontSize: 11 }} />
            <YAxis stroke="var(--color-muted)" tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip
              contentStyle={{
                background: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
              {data.map((d) => (
                <Cell key={d.priority} fill={COLOR_BY_P[d.p]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
