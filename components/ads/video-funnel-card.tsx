import type { VideoFunnelRow } from "@/lib/ads/video/stats";

/**
 * Playback for a pre-roll campaign.
 *
 * Deliberately not folded into the impressions/clicks row above it. Those
 * count what the ad network did; these count what the listener did, and the
 * whole reason the card exists is that the two can disagree — a campaign can
 * fill every break it is offered and never play a single frame.
 */
export function VideoFunnelCard({ row }: { row: VideoFunnelRow | null }) {
  // Nothing filled means nothing to explain; the render card above already
  // says whether the campaign even has a video.
  if (!row || row.fills === 0) return null;

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const seconds = (ms: number) => `${Math.round(ms / 1000).toLocaleString()}s`;

  const steps = [
    { label: "Filled", value: row.fills },
    { label: "Started", value: row.starts },
    { label: "25%", value: row.firstQuartile },
    { label: "50%", value: row.midpoint },
    { label: "75%", value: row.thirdQuartile },
    { label: "Finished", value: row.completes },
  ];

  return (
    <div className="card p-4">
      <h2 className="font-semibold">Playback</h2>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        A fill is a break this campaign won. A start is one that actually played. Last 30 days.
      </p>

      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {steps.map((s) => (
          <div key={s.label} className="rounded border border-[var(--color-border)] p-2 text-center">
            <div className="text-lg font-semibold tabular-nums">{s.value.toLocaleString()}</div>
            <div className="text-[11px] text-[var(--color-muted)]">{s.label}</div>
            {/* Width against fills, so the bar reads as the funnel narrowing
                rather than as six unrelated numbers. */}
            <div className="mt-1 h-1 rounded bg-[var(--color-border)]">
              <div
                className="h-1 rounded bg-[var(--color-accent)]"
                style={{ width: `${row.fills > 0 ? Math.round((s.value / row.fills) * 100) : 0}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <div className="font-semibold tabular-nums">{pct(row.startRate)}</div>
          <div className="text-xs text-[var(--color-muted)]">started, of fills</div>
        </div>
        <div>
          <div className="font-semibold tabular-nums">{pct(row.completionRate)}</div>
          <div className="text-xs text-[var(--color-muted)]">finished, of starts</div>
        </div>
        <div>
          <div className="font-semibold tabular-nums">{seconds(row.playedMs)}</div>
          <div className="text-xs text-[var(--color-muted)]">total watched</div>
        </div>
        <div>
          <div className="font-semibold tabular-nums">{row.clicks.toLocaleString()}</div>
          <div className="text-xs text-[var(--color-muted)]">clicks on the break</div>
        </div>
      </div>

      {row.starts === 0 && (
        <p className="mt-3 text-xs text-[var(--color-warning,#b45309)]">
          This campaign filled {row.fills.toLocaleString()} break(s) and no player reported a start.
          That usually means the publisher&apos;s player is not sending playback events — the
          drop-in helper at crawlproof.com/preroll.js does it for them.
        </p>
      )}

      {(row.errors > 0 || row.abandons > 0) && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          {row.errors.toLocaleString()} error(s), {row.abandons.toLocaleString()} left before the end.
        </p>
      )}
    </div>
  );
}
