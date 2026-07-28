import type { CampaignFunnel, FunnelCounts } from "@/lib/outreach/funnel";

/**
 * What outreach actually produced, across the project and per campaign.
 *
 * Deliberately not a projection. Published cold-email benchmarks are someone
 * else's list, someone else's offer and someone else's year, and dressing one
 * up as a forecast invites a decision the number cannot support. These are
 * this project's own sends and outcomes; they are worth little on day one and
 * more every week.
 *
 * Per-run numbers are not repeated here — each campaign already carries its
 * tick history above, which is where a single run belongs.
 */
function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function Row({ label, f }: { label: string; f: FunnelCounts }) {
  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="py-2 pr-3 font-medium">{label}</td>
      <td className="py-2 pr-3 text-right font-mono">{f.sent}</td>
      <td className="py-2 pr-3 text-right font-mono">
        {f.tracked ? f.opened : "—"}
        {f.openRate !== null && (
          <span className="ml-1 text-xs text-[var(--color-muted)]">{pct(f.openRate)}</span>
        )}
      </td>
      <td className="py-2 pr-3 text-right font-mono">{f.contacted}</td>
      <td className="py-2 pr-3 text-right font-mono">{f.replied}</td>
      <td className="py-2 pr-3 text-right font-mono">{f.won}</td>
      <td className="py-2 pr-3 text-right font-mono">{pct(f.replyRate)}</td>
      <td className="py-2 text-right font-mono">{pct(f.closeRate)}</td>
    </tr>
  );
}

export function FunnelPanel({
  project,
  campaigns,
}: {
  project: FunnelCounts;
  campaigns: CampaignFunnel[];
}) {
  if (project.sent === 0) {
    return (
      <section className="card p-4">
        <h2 className="text-lg font-semibold">Results</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Nothing has been sent for real yet. Once it has, this shows what came back — replies and
          closes measured from your own sends, not from published benchmarks.
        </p>
      </section>
    );
  }

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Results</h2>
        <p className="text-xs text-[var(--color-muted)]">
          Measured from your own sends. Dry runs excluded.
        </p>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="text-xs text-[var(--color-muted)]">
              <th className="pb-1 text-left font-medium">Campaign</th>
              <th className="pb-1 pr-3 text-right font-medium">Sent</th>
              <th className="pb-1 pr-3 text-right font-medium">Opened</th>
              <th className="pb-1 pr-3 text-right font-medium">People</th>
              <th className="pb-1 pr-3 text-right font-medium">Replied</th>
              <th className="pb-1 pr-3 text-right font-medium">Won</th>
              <th className="pb-1 pr-3 text-right font-medium">Reply rate</th>
              <th className="pb-1 text-right font-medium">Close rate</th>
            </tr>
          </thead>
          <tbody>
            <Row label="All campaigns" f={project} />
            {campaigns.map((c) => (
              <Row key={c.campaign} label={c.campaign} f={c} />
            ))}
          </tbody>
        </table>
      </div>

      {project.rateNote && (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Rates are held back until there is enough to divide by — {project.rateNote}. One reply out
          of three sends is not a 33% reply rate.
        </p>
      )}

      <p className="mt-2 text-xs text-[var(--color-muted)]">
        Reply rate is of people contacted; close rate is of people who replied, since a deal comes
        out of a conversation. Replies are read from your connected mailbox — out-of-office and
        bounce messages are recorded but not counted as replies.
      </p>

      <p className="mt-2 text-xs text-[var(--color-muted)]">
        Opens are a floor, not a count. Mail clients that block images report nothing, and loads
        from privacy proxies are discarded rather than counted — so the real number is higher than
        this one, never lower. Open rate is of tracked sends only.
      </p>
    </section>
  );
}
