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
  summary: { pass?: number; warn?: number; fail?: number } | null;
};

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
          <EngineCard key={a.id} audit={a} />
        ))}
      </div>
    </div>
  );
}

function EngineCard({ audit }: { audit: RunAudit }) {
  const meta = ENGINES[audit.engine];
  const pending = audit.status === "queued" || audit.status === "running";
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">{meta?.label ?? audit.engine}</h3>
            {meta && (
              <span className="text-xs text-[var(--color-muted)]">
                {meta.cost === 0 ? "free" : `${meta.cost} credit${meta.cost === 1 ? "" : "s"}`}
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
            <span className="font-semibold text-[var(--color-pass)]">{audit.summary.pass ?? 0}</span> pass
          </span>
          <span>
            <span className="font-semibold text-[var(--color-warn)]">{audit.summary.warn ?? 0}</span> warn
          </span>
          <span>
            <span className="font-semibold text-[var(--color-fail)]">{audit.summary.fail ?? 0}</span> fail
          </span>
        </div>
      )}

      {audit.status === "failed" && audit.failed_reason && (
        <p className="mt-3 break-words text-xs text-[var(--color-fail)]">
          {audit.failed_reason}
        </p>
      )}

      <div className="mt-3 flex items-center gap-3 text-xs">
        {audit.status === "complete" && (
          <Link href={`/audits/${audit.id}`} className="text-[var(--color-accent)] hover:underline">
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
