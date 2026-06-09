import type { Finding } from "@/lib/audit/types";
import { ApplyFixButton } from "./apply-fix-button";

interface FixContext {
  projectId: string;
  auditId: string;
  repos: Array<{ full_name: string; installation_id: number }>;
  boundRepos: Array<{ full_name: string; installation_id: number }>;
  fixesByAuditId?: Record<string, FixRun[]>;
}

export interface FixRun {
  id: string;
  audit_id: string | null;
  finding_key: string | null;
  status: "queued" | "running" | "opened" | "noop" | "failed";
  pr_url: string | null;
  pr_number: number | null;
  repo_owner: string;
  repo_name: string;
  branch_name: string | null;
  created_at: string;
  updated_at: string;
}

export function SectionFindings({
  findings,
  fixContext,
}: {
  findings: Finding[];
  fixContext?: FixContext;
}) {
  if (findings.length === 0) {
    return <p className="text-sm text-[var(--color-muted)]">No findings.</p>;
  }
  return (
    <ul className="space-y-2">
      {findings
        .sort((a, b) => a.priority - b.priority)
        .map((f, i) => (
          <FindingRow
            key={`${f.check_key}-${i}`}
            f={f}
            fixContext={fixContext}
          />
        ))}
    </ul>
  );
}

function FindingRow({
  f,
  fixContext,
}: {
  f: Finding;
  fixContext?: FixContext;
}) {
  const fixRun = latestFixForFinding(fixContext, f.check_key);
  const fixedViaPr = fixRun?.status === "opened";
  const fixRunning = fixRun?.status === "running" || fixRun?.status === "queued";
  const cls =
    fixedViaPr || f.status === "pass"
      ? "badge-pass"
      : f.status === "warn"
        ? "badge-warn"
        : f.status === "fail"
          ? "badge-fail"
          : "badge-unknown";
  const fixable =
    fixContext &&
    fixContext.repos.length > 0 &&
    (f.status === "fail" || f.status === "warn") &&
    !fixedViaPr &&
    !fixRunning;
  return (
    <li className="card p-4">
      <div className="flex items-start gap-3">
        <span className={`badge ${cls} uppercase`}>
          {fixedViaPr ? "fixed" : f.status}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold">{f.title}</div>
            {fixedViaPr && fixRun.pr_url && (
              <a
                href={fixRun.pr_url}
                target="_blank"
                rel="noreferrer"
                className="badge badge-pass text-xs hover:underline"
                title={`Submitted to ${fixRun.repo_owner}/${fixRun.repo_name}`}
              >
                Fixed via PR{fixRun.pr_number ? ` #${fixRun.pr_number}` : ""}
              </a>
            )}
            {fixedViaPr && !fixRun.pr_url && (
              <span
                className="badge badge-pass text-xs"
                title={`Submitted to ${fixRun.repo_owner}/${fixRun.repo_name}`}
              >
                Fixed via PR{fixRun.pr_number ? ` #${fixRun.pr_number}` : ""}
              </span>
            )}
            {fixRunning && (
              <span className="badge badge-warn text-xs">
                Fix PR running
              </span>
            )}
            {fixable && (
              <ApplyFixButton
                projectId={fixContext!.projectId}
                auditId={fixContext!.auditId}
                findingKey={f.check_key}
                findingTitle={f.title}
                repos={fixContext!.repos}
                boundRepos={fixContext!.boundRepos}
              />
            )}
          </div>
          {f.detail && (
            <p className="mt-1 whitespace-pre-line text-sm text-[var(--color-muted)]">
              {f.detail}
            </p>
          )}
          {f.evidence && Object.keys(f.evidence).length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-[var(--color-muted)]">
                Evidence
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-[var(--color-bg)] p-3 text-xs">
                {JSON.stringify(f.evidence, null, 2)}
              </pre>
            </details>
          )}
        </div>
        <span className="badge text-xs">P{f.priority}</span>
      </div>
    </li>
  );
}

function latestFixForFinding(
  fixContext: FixContext | undefined,
  findingKey: string,
): FixRun | undefined {
  if (!fixContext?.fixesByAuditId) return undefined;
  const runs = fixContext.fixesByAuditId[fixContext.auditId] ?? [];
  return runs.find(
    (run) =>
      run.finding_key === findingKey &&
      (run.status === "opened" || run.status === "running" || run.status === "queued"),
  );
}
