/**
 * Shown when a stats query failed, in place of the zeros it would otherwise
 * have rendered.
 *
 * The ad dashboards zero-fill on failure so one bad panel cannot take the page
 * down. Without this banner that choice is indistinguishable from a real run of
 * no delivery, which is how a live network reporting six figures of impressions
 * came to show four zeros and read as a dead pipeline.
 */
export function StatsUnavailable({ what = "these figures" }: { what?: string }) {
  return (
    <p
      role="status"
      className="mt-3 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-muted)]"
    >
      <span className="font-semibold text-[var(--color-fg)]">
        Couldn&apos;t load {what}.
      </span>{" "}
      The figures below are not zero — they are missing. This is usually a query
      that took too long; reloading often fixes it.
    </p>
  );
}
