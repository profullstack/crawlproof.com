export type IntentSignalRow = {
  source: string;
  url: string;
  title: string | null;
  snippet: string | null;
  score: number;
  tier: string;
  reasons: string[];
  posted_at: string | null;
  status: string;
};

const TIER_TONE: Record<string, string> = {
  purchase: "badge-pass",
  switching: "badge-pass",
  solicitation: "badge-warn",
  pain: "badge-unknown",
};

function age(posted: string | null): string {
  if (!posted) return "undated";
  const hours = (Date.now() - new Date(posted).getTime()) / 3_600_000;
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * People who publicly asked to buy, strongest and freshest first.
 *
 * Deliberately a separate queue from the lead pipeline rather than a column on
 * it. These are not companies with an address to email — they are individuals
 * on a platform, and the reply goes where they asked, in public, as a reply.
 * Treating them as prospects would file every Reddit thread under the domain
 * reddit.com and lose the person entirely.
 */
export function IntentPanel({ signals }: { signals: IntentSignalRow[] }) {
  if (!signals.length) return null;

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Asked to buy</h2>
        <p className="text-xs text-[var(--color-muted)]">
          Ranked by how explicitly they asked and how recently. Reply where they asked — not by
          email.
        </p>
      </div>

      <ul className="mt-3 divide-y divide-[var(--color-border)]">
        {signals.map((s) => (
          <li key={s.url} className="py-3">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`badge ${TIER_TONE[s.tier] ?? "badge-unknown"}`}>{s.tier}</span>
              <span className="font-mono text-xs">{s.score}/100</span>
              <span className="text-xs text-[var(--color-muted)]">
                {s.source} · {age(s.posted_at)}
              </span>
            </p>
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block font-medium underline"
            >
              {s.title || s.url}
            </a>
            {s.snippet && (
              <p className="mt-1 text-xs text-[var(--color-muted)]">{s.snippet}</p>
            )}
            {s.reasons.length > 0 && (
              <p className="mt-1 text-xs text-[var(--color-muted)]">{s.reasons.join(" · ")}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
