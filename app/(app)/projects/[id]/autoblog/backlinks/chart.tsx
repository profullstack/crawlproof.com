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

export type BacklinkTrendPoint = {
  date: string;
  incoming: number;
  outgoing: number;
  guestWritten: number;
  guestHosted: number;
};

export function BacklinkTrend({ data }: { data: BacklinkTrendPoint[] }) {
  const total = data.reduce(
    (sum, p) => sum + p.incoming + p.outgoing + p.guestWritten + p.guestHosted,
    0,
  );
  if (total === 0) {
    return (
      <div className="card flex h-64 items-center justify-center p-4 text-sm text-[var(--color-muted)]">
        No backlinks or guest posts recorded in the last 90 days.
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Backlinks over time</h2>
        <span className="text-xs text-[var(--color-muted)]">Last 90 days</span>
      </div>
      <div className="h-64 min-h-64 min-w-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={256}
          initialDimension={{ width: 640, height: 256 }}
        >
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              stroke="var(--color-muted)"
              tick={{ fontSize: 11 }}
              tickFormatter={(v: string) =>
                new Date(v).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })
              }
            />
            <YAxis
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
              type="monotone"
              dataKey="incoming"
              name="Incoming backlinks"
              stroke="var(--color-accent)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="outgoing"
              name="Outgoing backlinks"
              stroke="var(--color-warn)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="guestWritten"
              name="Guest posts written"
              stroke="var(--color-pass)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="guestHosted"
              name="Guest posts hosted"
              stroke="var(--color-fail)"
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
          Incoming
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-full bg-[var(--color-warn)]" />
          Outgoing
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-full bg-[var(--color-pass)]" />
          Written
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-full bg-[var(--color-fail)]" />
          Hosted
        </span>
      </div>
    </div>
  );
}
