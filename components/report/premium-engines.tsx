import Link from "next/link";
import { ENGINES, type Engine } from "@/lib/credits";
import { ScoreBadge } from "@/components/score-badge";

export type PremiumFinding = {
  section: string;
  status: string;
  title: string;
  detail: string | null;
  priority: number;
};

export type PremiumSibling = {
  id: string;
  engine: Engine;
  status: string;
  score: number | null;
  share_token: string | null;
  failed_reason: string | null;
  completed_at: string | null;
  summary: { pass?: number; warn?: number; fail?: number } | null;
  topFindings?: PremiumFinding[];
};

export function PremiumEngines({ siblings }: { siblings: PremiumSibling[] }) {
  const completed = siblings.filter(
    (s) => s.status === "complete" && s.score !== null,
  );
  const avgScore =
    completed.length > 0
      ? Math.round(
          completed.reduce((s, r) => s + (r.score ?? 0), 0) / completed.length,
        )
      : null;
  const runningCount = siblings.filter(
    (s) => s.status === "queued" || s.status === "running",
  ).length;

  return (
    <div className="space-y-6">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-accent)]">
            Premium
          </div>
          <h3 className="mt-1 text-lg font-bold">AI engine reports</h3>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {completed.length} of {siblings.length} engine
            {siblings.length === 1 ? "" : "s"} complete
            {avgScore !== null && ` · avg score ${avgScore}/100`}
            {runningCount > 0 && ` · ${runningCount} still running`}
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {siblings.map((a) => (
          <EngineCard key={a.id} audit={a} />
        ))}
      </div>
    </div>
  );
}

function EngineCard({ audit }: { audit: PremiumSibling }) {
  const meta = ENGINES[audit.engine];
  const pending = audit.status === "queued" || audit.status === "running";
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">
              {meta?.label ?? audit.engine}
            </h3>
            {meta && (
              <span className="text-xs text-[var(--color-muted)]">
                {meta.cost === 0
                  ? "free"
                  : `${meta.cost} credit${meta.cost === 1 ? "" : "s"}`}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
            {meta?.blurb ?? ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pending && (
            <span
              aria-hidden
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-accent)]"
            />
          )}
          <ScoreBadge score={audit.score} status={audit.status} />
        </div>
      </div>

      {audit.status === "complete" && audit.summary && (
        <div className="mt-3 flex gap-3 text-xs text-[var(--color-muted)]">
          <span>
            <span className="font-semibold text-[var(--color-pass)]">
              {audit.summary.pass ?? 0}
            </span>{" "}
            pass
          </span>
          <span>
            <span className="font-semibold text-[var(--color-warn)]">
              {audit.summary.warn ?? 0}
            </span>{" "}
            warn
          </span>
          <span>
            <span className="font-semibold text-[var(--color-fail)]">
              {audit.summary.fail ?? 0}
            </span>{" "}
            fail
          </span>
        </div>
      )}

      {audit.status === "failed" && audit.failed_reason && (
        <p className="mt-3 break-words text-xs text-[var(--color-fail)]">
          {audit.failed_reason}
        </p>
      )}

      {audit.status === "complete" &&
        audit.topFindings &&
        audit.topFindings.length > 0 && (
          <div className="mt-3 border-t border-[var(--color-border)] pt-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
              Top recommendations
            </div>
            <ul className="mt-2 space-y-1.5 text-xs">
              {audit.topFindings.map((f, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className={
                      f.status === "fail"
                        ? "mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-fail)]"
                        : "mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-warn)]"
                    }
                  />
                  <span className="min-w-0">
                    <span className="font-medium text-[var(--color-fg)]">
                      P{f.priority} · {f.title}
                    </span>
                    {f.detail && (
                      <span className="text-[var(--color-muted)]">
                        {" "}
                        — {f.detail}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

      <div className="mt-3 flex items-center gap-3 text-xs">
        {audit.status === "complete" && (
          <Link
            href={`/dashboard/audits/${audit.id}`}
            className="text-[var(--color-accent)] hover:underline"
          >
            View report →
          </Link>
        )}
        {audit.share_token && audit.status === "complete" && (
          <Link
            href={`/r/${audit.share_token}`}
            className="text-[var(--color-muted)] hover:underline"
          >
            Share link
          </Link>
        )}
      </div>
    </div>
  );
}
