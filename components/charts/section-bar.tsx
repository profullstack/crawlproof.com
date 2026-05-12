"use client";

import { useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";

export type SectionRow = {
  section: string;
  pass: number;
  warn: number;
  fail: number;
};

function useIsNarrow(breakpoint = 640): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [breakpoint]);
  return narrow;
}

export function SectionBar({ rows }: { rows: SectionRow[] }) {
  const narrow = useIsNarrow();
  if (rows.length === 0) {
    return (
      <div className="card flex h-64 items-center justify-center p-4 text-sm text-[var(--color-muted)]">
        No findings yet.
      </div>
    );
  }
  return (
    <div className="card p-4">
      <h3 className="mb-2 font-semibold">Findings by section</h3>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ top: 4, right: 12, bottom: 4, left: 4 }}
            stackOffset="expand"
          >
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" hide />
            <YAxis
              dataKey="section"
              type="category"
              width={narrow ? 96 : 170}
              stroke="var(--color-muted)"
              tick={{ fontSize: narrow ? 10 : 11 }}
              tickFormatter={(value: string) =>
                narrow && value.length > 14 ? `${value.slice(0, 13)}…` : value
              }
            />
            <Tooltip
              contentStyle={{
                background: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value, name) => [value, name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="pass" stackId="a" fill="var(--color-pass)" name="Pass" />
            <Bar dataKey="warn" stackId="a" fill="var(--color-warn)" name="Warn" />
            <Bar dataKey="fail" stackId="a" fill="var(--color-fail)" name="Fail" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
