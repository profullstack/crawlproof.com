import type { AccountPoint } from "@/lib/ads/series";

/**
 * Sparkline for a stat tile — one measure, server-rendered SVG, no recharts.
 *
 * The tile's number is the headline; this only carries shape, so it has no
 * axes, no labels and no hover. Every value it hints at is already reachable
 * from the main chart's tooltip and the per-campaign table below, which is what
 * lets it stay this bare.
 */
export function StatSpark({
  data,
  pick,
  color = "var(--color-chart-1)",
  width = 120,
  height = 28,
}: {
  data: AccountPoint[];
  pick: (p: AccountPoint) => number;
  color?: string;
  width?: number;
  height?: number;
}) {
  const values = data.map(pick);
  const max = Math.max(...values, 0);
  if (values.length < 2 || max <= 0) {
    return <div style={{ width, height }} aria-hidden="true" />;
  }

  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const stepX = w / (values.length - 1);
  const points = values
    .map((v, i) => `${(pad + i * stepX).toFixed(1)},${(pad + h - (v / max) * h).toFixed(1)}`)
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={`M${pad},${pad + h} L${points.split(" ").join(" L")} L${pad + w},${pad + h} Z`}
        fill={color}
        fillOpacity={0.14}
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
