import Link from "next/link";
import type { DeclaredSummary } from "@/lib/tracker/actorStore";

// Declared actors on this site (lib/tracker/actors.ts): what visitors SAID
// they are, kept apart from the measured tiles above it. Names appear only
// for the viewer's own actors or ones their owners made public; everyone else
// is in the per-kind totals and nowhere else (declaredSummary does the
// filtering, the same function the API and CLI read).
export function DeclaredCard({ summary, rangeLabel }: { summary: DeclaredSummary | null; rangeLabel: string }) {
  // Null means the actor tables are unreadable (or not migrated): say nothing
  // rather than print zeros that read as "nobody declared".
  if (!summary) return null;
  const { human, agent } = summary.totals;
  const contradictions = human.contradictions + agent.contradictions;

  if (human.events + agent.events === 0) {
    return (
      <p className="text-xs text-[var(--color-muted)]">
        No declared visitors in this window.{" "}
        <Link href="/dashboard/settings/actors" className="underline hover:text-[var(--color-foreground)]">
          Declare yourself or your agents →
        </Link>
      </p>
    );
  }

  return (
    <section className="card p-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Declared visitors</h2>
          <p className="text-sm text-[var(--color-muted)]">
            {rangeLabel}. Self-reported, opt-in: an agent is believed and counted as a bot; a human
            never overrides bot detection.
          </p>
        </div>
        <Link href="/dashboard/settings/actors" className="text-sm underline hover:text-[var(--color-foreground)]">
          Manage actors →
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Tile label="Declared humans" kind={human} />
        <Tile label="Declared agents" kind={agent} />
        <div className="rounded-md border border-[var(--color-border)] p-3">
          <div className="text-xs text-[var(--color-muted)]">Contradictions</div>
          <div className={`mt-1 text-2xl font-extrabold ${contradictions ? "text-[var(--color-fail)]" : ""}`}>
            {contradictions.toLocaleString()}
          </div>
          <div className="text-xs text-[var(--color-muted)]">
            Hits declared human that detection called a bot
          </div>
        </div>
      </div>

      {summary.actors.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--color-muted)]">
                <th className="py-1 pr-3 font-medium">Actor</th>
                <th className="py-1 pr-3 font-medium">Kind</th>
                <th className="py-1 pr-3 font-medium text-right">Pageviews</th>
                <th className="py-1 pr-3 font-medium text-right">Events</th>
                <th className="py-1 font-medium text-right">Contradicted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {summary.actors.map((a) => (
                <tr key={`${a.email}-${a.kind}`}>
                  <td className="py-1.5 pr-3">
                    {a.name || a.email}
                    {a.name && <span className="ml-1 text-xs text-[var(--color-muted)]">{a.email}</span>}
                    {!a.mine && <span className="ml-1 text-xs text-[var(--color-muted)]">(public)</span>}
                  </td>
                  <td className="py-1.5 pr-3">{a.kind}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{a.pageviews.toLocaleString()}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{a.events.toLocaleString()}</td>
                  <td className={`py-1.5 text-right tabular-nums ${a.contradictions ? "text-[var(--color-fail)]" : ""}`}>
                    {a.contradictions.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {summary.actors.length === 0 && (
        <p className="text-xs text-[var(--color-muted)]">
          None of these actors are yours or public, so only the totals are shown.
        </p>
      )}
    </section>
  );
}

function Tile({ label, kind }: { label: string; kind: { actors: number; events: number; pageviews: number } }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] p-3">
      <div className="text-xs text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 text-2xl font-extrabold">{kind.actors.toLocaleString()}</div>
      <div className="text-xs text-[var(--color-muted)]">
        {kind.pageviews.toLocaleString()} pageviews, {kind.events.toLocaleString()} events
      </div>
    </div>
  );
}
