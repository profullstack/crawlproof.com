import {
  attributedClicks,
  ctrReadable,
  ctrUnreadableNote,
  rotatedImpressions,
  UNATTRIBUTED,
  type MediaSplitRow,
} from "@/lib/ads/media-stats";

/**
 * How delivery split between the media a slot rotates through.
 *
 * Separate from the impressions/clicks tiles above it for the same reason the
 * playback card is: those count the network's delivery in total, this one counts
 * how that delivery was *presented*. A publisher's embed names a size and never
 * a medium, so this is the only place the choice the server made is visible.
 *
 * The CTR column is deliberately withheld rather than shown as zeros. On a
 * network with no third-party demand every arm reads 0.000%, which looks like a
 * completed experiment that found motion worthless — the most likely way this
 * table gets misread. See ctrUnreadableNote.
 */

const LABELS: Record<string, { name: string; hint: string }> = {
  static: { name: "Static", hint: "Code-drawn unit on a brand wash. No asset." },
  image: { name: "Hero image", hint: "The same unit with the advertiser's artwork." },
  gif: { name: "Animated", hint: "The rendered GIF at the slot's exact size." },
  video: { name: "In-banner video", hint: "Muted, looping MP4 with the CTA beneath." },
  audio: { name: "Audible companion", hint: "The unit plus a click-to-play control." },
  [UNATTRIBUTED]: {
    name: "Unattributed",
    hint: "Served before the rotation shipped, or a click whose impression cannot be resolved. Excluded from every share and rate.",
  },
};

export function MediaSplitCard({
  rows,
  rangeHint,
}: {
  rows: MediaSplitRow[];
  rangeHint?: string;
}) {
  const delivery = rotatedImpressions(rows);
  const unattributed = rows.find((r) => !r.rotated);

  // Nothing rotated in this window. The card would be a header over an empty
  // table, and the tiles above already say whether there was any delivery.
  if (delivery === 0 && !unattributed) return null;

  const showCtr = ctrReadable(rows);
  const note = ctrUnreadableNote(rows);
  const clicks = attributedClicks(rows);
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  return (
    <div className="card mt-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Delivery by medium</h2>
        {rangeHint && (
          <span className="text-xs text-[var(--color-muted)]">{rangeHint}</span>
        )}
      </div>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Your embed names a size, not a medium — the server picks one per fill from
        whatever each campaign has rendered. Only the rectangle can carry all five;
        a leaderboard takes no video and the mobile strip takes neither video nor
        artwork.
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[var(--color-muted)]">
              <th className="pb-2 font-medium">Medium</th>
              <th className="pb-2 text-right font-medium">Impressions</th>
              <th className="pb-2 text-right font-medium">Share</th>
              <th className="pb-2 text-right font-medium">Clicks</th>
              {showCtr && <th className="pb-2 text-right font-medium">CTR</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const label = LABELS[row.media] ?? { name: row.media, hint: "" };
              return (
                <tr
                  key={row.media}
                  className={`border-t border-[var(--color-border)] ${row.rotated ? "" : "text-[var(--color-muted)]"}`}
                >
                  <td className="py-2 pr-3">
                    <div className="font-medium">{label.name}</div>
                    {label.hint && (
                      <div className="text-[11px] text-[var(--color-muted)]">{label.hint}</div>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {row.impressions.toLocaleString()}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {row.rotated ? (
                      <div className="flex items-center justify-end gap-2">
                        {/* The bar is the whole point of the column: five
                            near-equal numbers is the rotation working, and a
                            lopsided one is a campaign pool that has not
                            rendered. That reads instantly and the percentages
                            do not. */}
                        <div className="h-1.5 w-16 rounded bg-[var(--color-border)]">
                          <div
                            className="h-1.5 rounded bg-[var(--color-accent)]"
                            style={{ width: `${Math.round(row.share * 100)}%` }}
                          />
                        </div>
                        <span>{pct(row.share)}</span>
                      </div>
                    ) : (
                      <span aria-hidden>—</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {(row.clicks + row.freeClicks).toLocaleString()}
                  </td>
                  {showCtr && (
                    <td className="py-2 text-right tabular-nums">
                      {row.ctr === null ? "—" : pct(row.ctr)}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {note && <p className="mt-3 text-xs text-[var(--color-muted)]">{note}</p>}

      {showCtr && (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          {clicks.toLocaleString()} clicks attributed. A rate this early separates
          the arms loosely at best — read it as a direction, not a verdict.
        </p>
      )}
    </div>
  );
}
