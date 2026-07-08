import type { CampaignDailyPoint } from "@/lib/ads/series";

/**
 * Tiny server-rendered SVG sparkline of impressions over time, with clicks as a
 * fainter overlay. No JS/recharts — cheap enough to render one per row in the
 * campaign list, mirroring the mini line graphs on the stats home view.
 */
export function MiniTrend({
  data,
  width = 132,
  height = 34,
}: {
  data: CampaignDailyPoint[];
  width?: number;
  height?: number;
}) {
  const total = data.reduce((n, p) => n + p.impressions, 0);
  if (data.length < 2 || total === 0) {
    return (
      <div
        className="flex items-center justify-center text-[10px] text-[var(--color-muted)]"
        style={{ width, height }}
      >
        no traffic yet
      </div>
    );
  }

  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const max = Math.max(...data.map((p) => p.impressions), 1);
  const stepX = w / (data.length - 1);

  const toPoints = (key: "impressions" | "clicks") =>
    data
      .map((p, i) => {
        const x = pad + i * stepX;
        const y = pad + h - (p[key] / max) * h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  const impPoints = toPoints("impressions");
  const areaPath = `M${pad},${pad + h} L${impPoints.split(" ").join(" L")} L${pad + w},${pad + h} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Impressions trend, ${total} total`}
      className="overflow-visible"
    >
      <path d={areaPath} fill="var(--color-accent)" fillOpacity={0.12} />
      <polyline
        points={impPoints}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {data.some((p) => p.clicks > 0) && (
        <polyline
          points={toPoints("clicks")}
          fill="none"
          stroke="var(--color-warn)"
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.9}
        />
      )}
    </svg>
  );
}
