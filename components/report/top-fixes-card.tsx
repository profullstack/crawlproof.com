import Link from "next/link";
import type { Finding } from "@/lib/audit/types";

/** Score, the five fixes that matter most, and the one next step: monitoring. */
export function TopFixesCard({
  host,
  score,
  fixes,
  token,
}: {
  host: string;
  score: number | null;
  fixes: Finding[];
  token: string;
}) {
  return (
    <section className="card mb-8 grid gap-6 p-6 md:grid-cols-[auto_1fr]">
      <div className="text-center md:pr-6 md:border-r md:border-[var(--color-border)]">
        <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">AI visibility</div>
        <div className="mt-1 text-5xl font-extrabold">{score ?? "–"}</div>
        <div className="text-sm text-[var(--color-muted)]">out of 100</div>
      </div>
      <div>
        <h2 className="text-lg font-bold">Top {fixes.length || ""} fixes for {host}</h2>
        {fixes.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">No failing checks. Keep it that way with weekly monitoring.</p>
        ) : (
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
            {fixes.map((f) => (
              <li key={f.check_key}>
                <span className="font-semibold">{f.title}</span>
                {f.detail && <span className="text-[var(--color-muted)]"> · {f.detail}</span>}
              </li>
            ))}
          </ol>
        )}
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link href={`/monitor?site=${encodeURIComponent(token)}`} className="btn btn-primary">
            Monitor this site weekly
          </Link>
          <span className="text-xs text-[var(--color-muted)]">
            Re-audited every week, emailed when the score changes. From $49/month.
          </span>
        </div>
      </div>
    </section>
  );
}
