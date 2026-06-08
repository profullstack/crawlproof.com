// AEO + GEO Score trend chart — server component. Renders the latest score, a
// small inline-SVG sparkline of recent project_scores rows, and the change
// since the start of the window. No charting library; the SVG is hand-
// rolled to keep the bundle clean.

import { createClient } from "@/lib/supabase/server";
import { ENGINES, type Engine } from "@/lib/credits";

interface AeoScoreTrendProps {
  projectId: string;
  /** How many recent points to plot. Defaults to 30. */
  limit?: number;
}

type ScoreRow = {
  score: number;
  components: Record<string, number> | null;
  recorded_at: string;
};

export async function AeoScoreTrend({ projectId, limit = 30 }: AeoScoreTrendProps) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("project_scores")
    .select("score, components, recorded_at")
    .eq("project_id", projectId)
    .order("recorded_at", { ascending: false })
    .limit(limit);

  const rows = ((data ?? []) as ScoreRow[]).slice().reverse(); // oldest → newest
  if (rows.length === 0) {
    return (
      <section className="card p-4">
        <h2 className="text-lg font-semibold">AEO + GEO Score</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          No scored runs yet. Once a scan completes, your AEO + GEO Score trend
          will appear here.
        </p>
      </section>
    );
  }

  const latest = rows[rows.length - 1];
  const first = rows[0];
  const delta = latest.score - first.score;
  const tone =
    latest.score >= 80 ? "pass" : latest.score >= 50 ? "warn" : "fail";

  // Sparkline geometry — fixed viewBox so the SVG scales cleanly.
  const W = 320;
  const H = 64;
  const padX = 4;
  const padY = 6;
  const xs = rows.map((_, i) =>
    rows.length === 1
      ? W / 2
      : padX + (i * (W - padX * 2)) / (rows.length - 1),
  );
  const ys = rows.map(
    (r) => padY + ((100 - r.score) * (H - padY * 2)) / 100,
  );
  const points = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`);

  const components = latest.components ?? {};
  const componentEntries = Object.entries(components).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold">AEO + GEO Score</h2>
          <span
            className={`text-3xl font-bold ${
              tone === "pass"
                ? "text-green-600"
                : tone === "warn"
                  ? "text-yellow-600"
                  : "text-red-600"
            }`}
          >
            {latest.score}
          </span>
          {rows.length > 1 && (
            <span
              className={`text-sm ${
                delta > 0
                  ? "text-green-600"
                  : delta < 0
                    ? "text-red-600"
                    : "text-[var(--color-muted)]"
              }`}
            >
              {delta > 0 ? "+" : ""}
              {delta} over {rows.length} runs
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--color-muted)]">
          Last updated {new Date(latest.recorded_at).toLocaleString()}
        </p>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-16 w-full"
        preserveAspectRatio="none"
        aria-label="AEO + GEO Score trend"
      >
        {rows.length > 1 && (
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            points={points.join(" ")}
            className={
              tone === "pass"
                ? "text-green-500"
                : tone === "warn"
                  ? "text-yellow-500"
                  : "text-red-500"
            }
          />
        )}
        {xs.map((x, i) => (
          <circle
            key={i}
            cx={x}
            cy={ys[i]}
            r={i === rows.length - 1 ? 3 : 1.5}
            className={
              tone === "pass"
                ? "fill-green-500"
                : tone === "warn"
                  ? "fill-yellow-500"
                  : "fill-red-500"
            }
          />
        ))}
      </svg>

      {componentEntries.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
          {componentEntries.map(([engine, score]) => (
            <span key={engine}>
              <span>{ENGINES[engine as Engine]?.label ?? engine}</span>:{" "}
              <span className="font-medium text-[var(--color-foreground)]">
                {score}
              </span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
