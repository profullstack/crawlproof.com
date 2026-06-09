import { SECTIONS } from "@/lib/audit/prompt";
import { SectionFindings, type FixRun } from "./section";
import { DataFoundTable } from "./data-found";
import type { Finding } from "@/lib/audit/types";
import { ENGINES, type Engine } from "@/lib/credits";

const VU1NZ_REPORT_SECTION = "Vu1nz Security Assessment";

export type AuditRow = {
  id: string;
  target_url: string;
  status: string;
  score: number | null;
  summary: Record<string, unknown>;
  completed_at: string | null;
  created_at: string;
  share_token?: string | null;
  engine?: string | null;
};

export type MultiEngineAuditRow = AuditRow & {
  failed_reason?: string | null;
};

interface FixContext {
  projectId: string;
  auditId: string;
  repos: Array<{ full_name: string; installation_id: number }>;
  boundRepos: Array<{ full_name: string; installation_id: number }>;
  fixesByAuditId?: Record<string, FixRun[]>;
}

export function ReportView({
  audit,
  findings,
  ownerActions,
  fixContext,
}: {
  audit: AuditRow;
  findings: Finding[];
  ownerActions?: React.ReactNode;
  fixContext?: FixContext;
}) {
  const dataFound = ((audit.summary as { dataFound?: unknown[] })?.dataFound ?? []) as Array<{
    dataPoint: string;
    found: boolean;
    source: string | null;
    notes: string | null;
  }>;
  const sections = reportSections(findings, audit.engine);

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr] lg:gap-8">
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <details className="card p-4 text-sm lg:!block" open>
          <summary className="cursor-pointer list-none text-xs uppercase tracking-wider text-[var(--color-muted)] lg:cursor-default [&::-webkit-details-marker]:hidden">
            Sections
          </summary>
          <nav className="mt-3 flex flex-col gap-1">
            {sections.map((s, i) => (
              <a key={s} href={`#section-${i + 1}`} className="rounded px-2 py-1 hover:bg-[var(--color-bg)]">
                {i + 1}. {s}
              </a>
            ))}
          </nav>
        </details>
      </aside>

      <article className="space-y-10">
        <header className="card p-4 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                AEO audit
              </p>
              <h1 className="mt-1 text-2xl font-extrabold break-all sm:text-3xl">{audit.target_url}</h1>
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                {audit.completed_at
                  ? `Completed ${new Date(audit.completed_at).toLocaleString()}`
                  : `Started ${new Date(audit.created_at).toLocaleString()}`}
              </p>
            </div>
            <div className="flex items-center gap-3 sm:flex-shrink-0">
              <ScoreDial score={audit.score} status={audit.status} />
              {ownerActions}
            </div>
          </div>
        </header>

        {sections.map((s, i) => {
          const sectionFindings = findings.filter((f) => f.section === s);
          if (s === "Data Found") {
            return (
              <SectionShell key={s} index={i + 1} title={s}>
                <DataFoundTable rows={dataFound} />
              </SectionShell>
            );
          }
          return (
            <SectionShell key={s} index={i + 1} title={s}>
              <SectionFindings
                findings={sectionFindings}
                fixContext={fixContext}
              />
            </SectionShell>
          );
        })}
      </article>
    </div>
  );
}

export function MultiEngineReportView({
  audits,
  findingsByAuditId,
  ownerActions,
  fixContext,
}: {
  audits: MultiEngineAuditRow[];
  findingsByAuditId: Map<string, Finding[]>;
  ownerActions?: React.ReactNode;
  fixContext?: FixContext;
}) {
  const first = audits[0];
  const completed = audits.filter(
    (a) => a.status === "complete" && a.score !== null,
  );
  const avgScore =
    completed.length > 0
      ? Math.round(
          completed.reduce((sum, a) => sum + (a.score ?? 0), 0) /
            completed.length,
        )
      : null;
  const rollup = audits.reduce(
    (out, a) => {
      if (a.status !== "complete") return out;
      const summary = a.summary as { pass?: number; warn?: number; fail?: number } | null;
      out.pass += summary?.pass ?? 0;
      out.warn += summary?.warn ?? 0;
      out.fail += summary?.fail ?? 0;
      return out;
    },
    { pass: 0, warn: 0, fail: 0 },
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr] lg:gap-8">
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <details className="card p-4 text-sm lg:!block" open>
          <summary className="cursor-pointer list-none text-xs uppercase tracking-wider text-[var(--color-muted)] lg:cursor-default [&::-webkit-details-marker]:hidden">
            Engines
          </summary>
          <nav className="mt-3 flex flex-col gap-1">
            <a href="#scan-overview" className="rounded px-2 py-1 hover:bg-[var(--color-bg)]">
              Overview
            </a>
            {audits.map((audit) => (
              <a
                key={audit.id}
                href={`#engine-${audit.id}`}
                className="rounded px-2 py-1 hover:bg-[var(--color-bg)]"
              >
                {engineLabel(audit.engine)}
              </a>
            ))}
          </nav>
        </details>
      </aside>

      <article className="space-y-10">
        <header id="scan-overview" className="card p-4 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Multi-engine AEO audit
              </p>
              <h1 className="mt-1 text-2xl font-extrabold break-all sm:text-3xl">
                {first.target_url}
              </h1>
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                {completed.length} of {audits.length} engine
                {audits.length === 1 ? "" : "s"} complete
                {avgScore !== null && ` · average ${avgScore}/100`}
              </p>
            </div>
            <div className="flex items-center gap-3 sm:flex-shrink-0">
              <ScoreDial score={avgScore} status={completed.length > 0 ? "complete" : first.status} />
              {ownerActions}
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-5 text-sm text-[var(--color-muted)]">
            <Count label="pass" value={rollup.pass} tone="pass" />
            <Count label="warn" value={rollup.warn} tone="warn" />
            <Count label="fail" value={rollup.fail} tone="fail" />
          </div>
        </header>

        {audits.map((audit) => (
          <EngineReport
            key={audit.id}
            audit={audit}
            findings={findingsByAuditId.get(audit.id) ?? []}
            fixContext={
              fixContext ? { ...fixContext, auditId: audit.id } : undefined
            }
          />
        ))}
      </article>
    </div>
  );
}

function EngineReport({
  audit,
  findings,
  fixContext,
}: {
  audit: MultiEngineAuditRow;
  findings: Finding[];
  fixContext?: FixContext;
}) {
  const dataFound = ((audit.summary as { dataFound?: unknown[] })?.dataFound ?? []) as Array<{
    dataPoint: string;
    found: boolean;
    source: string | null;
    notes: string | null;
  }>;
  const sections = reportSections(findings, audit.engine);
  const summary = audit.summary as { pass?: number; warn?: number; fail?: number } | null;

  return (
    <section id={`engine-${audit.id}`} className="space-y-5">
      <div className="card p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Engine
            </p>
            <h2 className="mt-1 text-xl font-bold">
              {engineLabel(audit.engine)}
            </h2>
            {audit.engine && ENGINES[audit.engine as Engine]?.blurb && (
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                {ENGINES[audit.engine as Engine].blurb}
              </p>
            )}
            {audit.status === "failed" && audit.failed_reason && (
              <p className="mt-2 text-sm text-[var(--color-fail)]">
                {audit.failed_reason}
              </p>
            )}
          </div>
          <ScoreDial score={audit.score} status={audit.status} />
        </div>
        {audit.status === "complete" && summary && (
          <div className="mt-4 flex flex-wrap gap-5 text-sm text-[var(--color-muted)]">
            <Count label="pass" value={summary.pass ?? 0} tone="pass" />
            <Count label="warn" value={summary.warn ?? 0} tone="warn" />
            <Count label="fail" value={summary.fail ?? 0} tone="fail" />
          </div>
        )}
      </div>

      {audit.status !== "complete" ? (
        <p className="text-sm text-[var(--color-muted)]">
          This engine is {audit.status}.
        </p>
      ) : (
        sections.map((s, i) => {
          const sectionFindings = findings.filter((f) => f.section === s);
          if (s === "Data Found") {
            return (
              <SectionShell key={`${audit.id}-${s}`} index={i + 1} title={s}>
                <DataFoundTable rows={dataFound} />
              </SectionShell>
            );
          }
          return (
            <SectionShell key={`${audit.id}-${s}`} index={i + 1} title={s}>
              <SectionFindings
                findings={sectionFindings}
                fixContext={fixContext}
              />
            </SectionShell>
          );
        })
      )}
    </section>
  );
}

export function reportSections(findings: Finding[], engine?: string | null): string[] {
  const findingSections = Array.from(
    new Set(findings.map((f) => f.section).filter(Boolean)),
  );
  const compactEngine =
    engine === "dns" || engine === "posture" || engine === "links" || engine === "spec";
  if (compactEngine) {
    return findingSections.length > 0 ? findingSections : [...SECTIONS];
  }
  const out = [...SECTIONS];
  for (const section of findingSections) {
    if (!out.includes(section as (typeof SECTIONS)[number])) {
      out.push(section as (typeof SECTIONS)[number]);
    }
  }
  if (engine === "vu1nz" && !out.includes(VU1NZ_REPORT_SECTION as (typeof SECTIONS)[number])) {
    out.push(VU1NZ_REPORT_SECTION as (typeof SECTIONS)[number]);
  }
  return out;
}

function SectionShell({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={`section-${index}`} className="space-y-3">
      <h2 className="text-xl font-bold">
        <span className="text-[var(--color-muted)]">{index}.</span> {title}
      </h2>
      {children}
    </section>
  );
}

function ScoreDial({ score, status }: { score: number | null; status: string }) {
  if (status !== "complete" || score === null) {
    return <span className="badge badge-unknown">{status}</span>;
  }
  const tone = score >= 80 ? "var(--color-pass)" : score >= 50 ? "var(--color-warn)" : "var(--color-fail)";
  return (
    <div
      className="flex size-20 items-center justify-center rounded-full border-2 text-center"
      style={{ borderColor: tone }}
    >
      <div>
        <div className="text-2xl font-extrabold" style={{ color: tone }}>{score}</div>
        <div className="text-[10px] uppercase text-[var(--color-muted)]">/100</div>
      </div>
    </div>
  );
}

function Count({
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
    <span>
      <span className="font-semibold" style={{ color }}>
        {value}
      </span>{" "}
      {label}
    </span>
  );
}

function engineLabel(engine?: string | null): string {
  if (!engine) return "Unknown engine";
  return ENGINES[engine as Engine]?.label ?? engine;
}
