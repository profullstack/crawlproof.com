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
  Legend,
} from "recharts";
import { ENGINES, type Engine } from "@/lib/credits";

// One series per engine on the same time axis. `data` is sparse — a point
// has only the engines that completed in that scan run; missing engines
// just don't appear on that x-tick. Recharts draws gaps automatically.
export type EngineTrendPoint = {
  date: string;
} & Partial<Record<Engine, number>>;

const ENGINE_COLORS: Record<Engine, string> = {
  rule: "#9aa3b2",
  claude: "#d97706",
  openai: "#10b981",
  gemini: "#3b82f6",
  qwen: "#a855f7",
  kimi: "#ec4899",
  deepseek: "#ef4444",
  perplexity: "#06b6d4",
};

export function EngineTrend({
  data,
  engines,
  title = "Score over time, per engine",
}: {
  data: EngineTrendPoint[];
  engines: Engine[];
  title?: string;
}) {
  if (data.length === 0 || engines.length === 0) {
    return (
      <div className="card flex h-72 items-center justify-center p-4 text-sm text-[var(--color-muted)]">
        Not enough engine runs yet to plot.
      </div>
    );
  }
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-semibold">{title}</h3>
        <span className="text-xs text-[var(--color-muted)]">
          {data.length} run{data.length === 1 ? "" : "s"} · {engines.length}{" "}
          engine{engines.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="h-72 min-h-72 min-w-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={288}
          initialDimension={{ width: 320, height: 288 }}
        >
          <LineChart
            data={data}
            margin={{ top: 8, right: 16, bottom: 0, left: -16 }}
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
              tickFormatter={(v: string) =>
                new Date(v).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })
              }
            />
            <YAxis
              domain={[0, 100]}
              stroke="var(--color-muted)"
              tick={{ fontSize: 11 }}
              ticks={[0, 25, 50, 75, 100]}
            />
            <ReferenceLine
              y={80}
              stroke="var(--color-pass)"
              strokeDasharray="3 3"
            />
            <ReferenceLine
              y={50}
              stroke="var(--color-warn)"
              strokeDasharray="3 3"
            />
            <Tooltip
              contentStyle={{
                background: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(v) =>
                typeof v === "string" ? new Date(v).toLocaleString() : ""
              }
              formatter={(value, name) => {
                const meta = ENGINES[name as Engine];
                return [`${value}/100`, meta?.label ?? name];
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              formatter={(value) => ENGINES[value as Engine]?.label ?? value}
            />
            {engines.map((e) => (
              <Line
                key={e}
                type="monotone"
                dataKey={e}
                stroke={ENGINE_COLORS[e]}
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
