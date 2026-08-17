"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ENGINES, type Engine } from "@/lib/credits";
import { ScoreBadge } from "@/components/score-badge";

type RunAudit = {
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

export function ScanRunPoller({
  projectId,
  runId,
  initial,
  initialAllDone,
}: {
  projectId: string;
  runId: string;
  initial: RunAudit[];
  initialAllDone: boolean;
}) {
  const [rows, setRows] = useState<RunAudit[]>(initial);
  const [allDone, setAllDone] = useState(initialAllDone);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (allDone) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [allDone]);

  useEffect(() => {
    if (allDone) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/runs/${runId}/status`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { audits?: RunAudit[] };
        if (cancelled || !data.audits) return;
        setRows(data.audits);
        const done = data.audits.every(
          (r) => r.status === "complete" || r.status === "failed",
        );
        if (done) setAllDone(true);
      } catch {
        /* keep polling */
      }
    };
    const id = setInterval(tick, 4000);
    // Initial pull right away — otherwise the first refresh is 4s out.
    tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectId, runId, allDone]);

  const completed = rows.filter((r) => r.status === "complete" && r.score !== null);
  const avgScore =
    completed.length > 0
      ? Math.round(
          completed.reduce((s, r) => s + (r.score ?? 0), 0) / completed.length,
        )
      : null;
  const runningCount = rows.filter(
    (r) => r.status === "queued" || r.status === "running",
  ).length;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          label="Engines run"
          value={`${completed.length} / ${rows.length}`}
        />
        <Metric
          label="Average score"
          value={avgScore === null ? "—" : `${avgScore}`}
          tone={
            avgScore === null
              ? "muted"
              : avgScore >= 80
                ? "pass"
                : avgScore >= 50
                  ? "warn"
                  : "fail"
          }
        />
        <Metric
          label="In progress"
          value={runningCount === 0 ? "done" : `${runningCount} running`}
          tone={runningCount === 0 ? "pass" : "muted"}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((a) => (
          <EngineCard key={a.id} audit={a} now={now} />
        ))}
      </div>
    </div>
  );
}

function statusMessage(audit: RunAudit): string {
  if (audit.status === "queued") return "Waiting for a worker to pick this up";
  if (audit.status === "running") return "Auditing your site…";
  if (audit.status === "failed") return "Scan failed";
  return "";
}

function EngineCard({ audit, now }: { audit: RunAudit; now: number }) {
  const meta = ENGINES[audit.engine];
  const pending = audit.status === "queued" || audit.status === "running";
  const startedAt = new Date(audit.created_at).getTime();
  const endedAt = audit.completed_at
    ? new Date(audit.completed_at).getTime()
    : null;
  const elapsedMs = (endedAt ?? now) - startedAt;
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

      {pending && (
        <div className="mt-3 space-y-1 text-xs">
          <p className="text-[var(--color-fg)]">{statusMessage(audit)}</p>
          <p className="text-[var(--color-muted)]">
            Elapsed {formatDuration(elapsedMs)} · started{" "}
            {new Date(audit.created_at).toLocaleTimeString()}
          </p>
        </div>
      )}

      {audit.status === "complete" && (
        <div className="mt-3 space-y-1">
          {audit.summary && (
            <div className="flex gap-3 text-xs text-[var(--color-muted)]">
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
          <p className="text-xs text-[var(--color-muted)]">
            Took {formatDuration(elapsedMs)}
          </p>
        </div>
      )}

      {audit.status === "failed" && (
        <div className="mt-3 space-y-1 text-xs">
          {audit.failed_reason && (
            <p className="break-words text-[var(--color-fail)]">
              {audit.failed_reason}
            </p>
          )}
          <p className="text-[var(--color-muted)]">
            Failed after {formatDuration(elapsedMs)}
          </p>
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

function Metric({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: "pass" | "warn" | "fail" | "muted";
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
    <div className="card p-3">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-extrabold" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
