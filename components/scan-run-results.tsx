import Link from "next/link";
import { ENGINES, type Engine } from "@/lib/credits";
import { ScoreBadge } from "@/components/score-badge";

export type RunAudit = {
  id: string;
  engine: Engine;
  status: string;
  score: number | null;
  share_token: string | null;
  failed_reason: string | null;
  completed_at: string | null;
  created_at: string;
  summary: { pass?: number; warn?: number; fail?: number } | null;
};

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

function totalCreditsSpent(rows: RunAudit[]): number {
  return rows.reduce((sum, r) => sum + (ENGINES[r.engine]?.cost ?? 0), 0);
}

function rolledUpCounts(
  rows: RunAudit[],
): { pass: number; warn: number; fail: number } {
  const out = { pass: 0, warn: 0, fail: 0 };
  for (const r of rows) {
    if (r.status !== "complete") continue;
    out.pass += r.summary?.pass ?? 0;
    out.warn += r.summary?.warn ?? 0;
    out.fail += r.summary?.fail ?? 0;
  }
  return out;
}

export function ScanRunResults({
  rows,
  targetUrl,
  ownerActions,
  backHref,
  backLabel,
}: {
  rows: RunAudit[];
  targetUrl: string;
  ownerActions?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  const first = rows[0];
  const completed = rows.filter(
    (r) => r.status === "complete" && r.score !== null,
  );
  const avgScore =
    completed.length > 0
      ? Math.round(
          completed.reduce((s, r) => s + (r.score ?? 0), 0) / completed.length,
        )
      : null;
  const runningCount = rows.filter(
    (r) => r.status === "queued" || r.status === "running",
  ).length;
  const failedCount = rows.filter((r) => r.status === "failed").length;
  const credits = totalCreditsSpent(rows);
  const rollup = rolledUpCounts(rows);

  const startedAt = new Date(first.created_at);
  const latestCompletedAt = completed
    .map((r) => (r.completed_at ? new Date(r.completed_at).getTime() : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  const runtimeMs =
    latestCompletedAt > 0 ? latestCompletedAt - startedAt.getTime() : null;

  return (
    <div className="space-y-6">
      <header className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {backHref && (
              <Link
                href={backHref}
                className="text-sm text-[var(--color-muted)]"
              >
                ← {backLabel ?? "Back"}
              </Link>
            )}
            <h1 className="mt-2 text-2xl font-bold">Scan run</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              <a
                href={targetUrl}
                target="_blank"
                rel="noreferrer"
                className="break-all hover:underline"
              >
                {targetUrl}
              </a>
            </p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Started {startedAt.toLocaleString()}
            </p>
          </div>
          {ownerActions}
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-4">
          <Metric
            label="Average score"
            value={avgScore === null ? "—" : String(avgScore)}
            tone={
              avgScore === null
                ? "muted"
                : avgScore >= 80
                  ? "pass"
                  : avgScore >= 50
                    ? "warn"
                    : "fail"
            }
            suffix={avgScore === null ? undefined : "/ 100"}
          />
          <Metric
            label="Engines"
            value={`${completed.length} / ${rows.length}`}
            tone="muted"
            note={
              runningCount > 0
                ? `${runningCount} running`
                : failedCount > 0
                  ? `${failedCount} failed`
                  : "all complete"
            }
          />
          <Metric
            label="Credits spent"
            value={String(credits)}
            tone="muted"
            note={credits === 0 ? "free scan" : undefined}
          />
          <Metric
            label={runtimeMs === null ? "Status" : "Total runtime"}
            value={runtimeMs === null ? "running" : formatDuration(runtimeMs)}
            tone={runningCount === 0 ? "pass" : "warn"}
          />
        </div>
      </header>

      {completed.length > 0 && (
        <div className="card p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
            Findings across {completed.length} engine
            {completed.length === 1 ? "" : "s"}
          </h2>
          <div className="mt-3 flex flex-wrap gap-6 text-sm">
            <RollupCount label="pass" value={rollup.pass} tone="pass" />
            <RollupCount label="warn" value={rollup.warn} tone="warn" />
            <RollupCount label="fail" value={rollup.fail} tone="fail" />
          </div>
        </div>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Engine breakdown</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((a) => (
            <EngineCard key={a.id} audit={a} />
          ))}
        </div>
      </section>
    </div>
  );
}

function EngineCard({ audit }: { audit: RunAudit }) {
  const meta = ENGINES[audit.engine];
  const pending = audit.status === "queued" || audit.status === "running";
  const startedAt = new Date(audit.created_at).getTime();
  const endedAt = audit.completed_at
    ? new Date(audit.completed_at).getTime()
    : null;
  const durationMs = endedAt !== null ? endedAt - startedAt : null;

  return (
    <article className="card p-4">
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
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
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
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--color-muted)]">
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
          {durationMs !== null && (
            <span className="ml-auto">Took {formatDuration(durationMs)}</span>
          )}
        </div>
      )}

      {audit.status === "failed" && audit.failed_reason && (
        <p className="mt-3 break-words text-xs text-[var(--color-fail)]">
          {audit.failed_reason}
        </p>
      )}

      {pending && (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          {audit.status === "queued"
            ? "Waiting for a worker to pick this up"
            : "Auditing your site…"}
        </p>
      )}

      <div className="mt-3 flex items-center gap-3 text-xs">
        {audit.status === "complete" && (
          <Link
            href={`/audits/${audit.id}`}
            className="text-[var(--color-accent)] hover:underline"
          >
            View full report →
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
    </article>
  );
}

function Metric({
  label,
  value,
  tone,
  suffix,
  note,
}: {
  label: string;
  value: string;
  tone: "pass" | "warn" | "fail" | "muted";
  suffix?: string;
  note?: string;
}) {
  const color =
    tone === "pass"
      ? "var(--color-pass)"
      : tone === "warn"
        ? "var(--color-warn)"
        : tone === "fail"
          ? "var(--color-fail)"
          : "var(--color-fg)";
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <div className="text-2xl font-extrabold" style={{ color }}>
          {value}
        </div>
        {suffix && (
          <span className="text-xs text-[var(--color-muted)]">{suffix}</span>
        )}
      </div>
      {note && (
        <div className="mt-0.5 text-xs text-[var(--color-muted)]">{note}</div>
      )}
    </div>
  );
}

function RollupCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "pass" | "warn" | "fail";
}) {
  const color =
    tone === "pass"
      ? "var(--color-pass)"
      : tone === "warn"
        ? "var(--color-warn)"
        : "var(--color-fail)";
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-2xl font-bold" style={{ color }}>
        {value}
      </span>
      <span className="text-sm uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </span>
    </div>
  );
}
