import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  MultiEngineReportView,
  ReportView,
  type AuditRow,
  type MultiEngineAuditRow,
} from "@/components/report/report-view";
import { MarkdownView } from "@/components/report/markdown-view";
import { ViewTabs } from "@/components/report/view-tabs";
import { PerformancePreview } from "@/components/report/performance-preview";
import {
  PremiumEngines,
  type PremiumSibling,
} from "@/components/report/premium-engines";
import { LivePoller } from "@/components/report/live-poller";
import { DiffView } from "@/components/report/diff-view";
import { CopyLink } from "@/components/copy-link";
import { PdfButton } from "@/components/pdf-button";
import { ShareBanner } from "@/components/share-banner";
import type { Finding } from "@/lib/audit/types";
import type { FixRun } from "@/components/report/section";
import { loadConsolidatedOrSoloMarkdown } from "@/lib/audit/summary-markdown";
import { env } from "@/lib/env";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import { listInstallationRepos } from "@/lib/github/app";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ diff?: string }>;
}) {
  const { id } = await params;
  const { diff } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: audit } = await supabase
    .from("audits")
    .select("id, target_url, status, score, summary, report_markdown, completed_at, created_at, share_token, owner_id, project_id, scan_run_id, engine")
    .eq("id", id)
    .maybeSingle();
  if (!audit) notFound();

  const isOwner = audit.owner_id === user!.id;
  let isMember = false;
  if (!isOwner && audit.project_id) {
    const { data: memberCheck } = await supabase
      .from("project_members")
      .select("id")
      .eq("project_id", audit.project_id)
      .eq("user_id", user!.id)
      .maybeSingle();
    isMember = !!memberCheck;
    if (!isMember) {
      const { data: project } = await supabase
        .from("projects")
        .select("organization_id")
        .eq("id", audit.project_id)
        .maybeSingle();
      const orgId = (project as { organization_id?: string | null } | null)?.organization_id;
      if (orgId) {
        const { data: orgMemberCheck } = await supabase
          .from("organization_members")
          .select("id")
          .eq("organization_id", orgId)
          .eq("user_id", user!.id)
          .in("role", ["owner", "member"])
          .maybeSingle();
        isMember = !!orgMemberCheck;
      }
    }
  }
  if (!isOwner && !isMember) notFound();

  // The visible report must represent the whole scan run, not just the
  // specific engine row whose URL the user opened.
  const { data: scanRunAuditsData } = audit.scan_run_id
    ? await supabase
        .from("audits")
        .select(
          "id, target_url, status, score, summary, completed_at, created_at, share_token, engine, failed_reason",
        )
        .eq("scan_run_id", audit.scan_run_id)
        .order("created_at", { ascending: true })
    : { data: null };
  const reportAudits =
    ((scanRunAuditsData ?? []) as unknown as MultiEngineAuditRow[]).length > 0
      ? ((scanRunAuditsData ?? []) as unknown as MultiEngineAuditRow[])
      : [audit as MultiEngineAuditRow];
  const reportAuditIds = reportAudits.map((row) => row.id);

  const { data: allFindingsData } =
    reportAuditIds.length > 0
      ? await supabase
          .from("audit_findings")
          .select("audit_id, section, check_key, status, title, detail, evidence, priority")
          .in("audit_id", reportAuditIds)
          .order("priority", { ascending: true })
      : { data: null };
  const findingsByAuditId = new Map<string, Finding[]>();
  for (const row of (allFindingsData ?? []) as Array<
    Finding & { audit_id: string }
  >) {
    const list = findingsByAuditId.get(row.audit_id) ?? [];
    list.push({
      section: row.section,
      check_key: row.check_key,
      status: row.status,
      title: row.title,
      detail: row.detail,
      evidence: row.evidence,
      priority: row.priority,
    });
    findingsByAuditId.set(row.audit_id, list);
  }
  const findings = findingsByAuditId.get(audit.id) ?? [];
  const fixesByAuditId: Record<string, FixRun[]> = {};
  if (user && audit.project_id && reportAuditIds.length > 0) {
    const { data: fixRunsData } = await supabase
      .from("project_pr_runs")
      .select("id, audit_id, finding_key, status, pr_url, pr_number, repo_owner, repo_name, branch_name, created_at, updated_at")
      .eq("project_id", audit.project_id)
      .eq("kind", "apply_fix")
      .in("audit_id", reportAuditIds)
      .in("status", ["opened", "running", "queued"])
      .order("created_at", { ascending: false });

    for (const run of (fixRunsData ?? []) as FixRun[]) {
      if (!run.audit_id) continue;
      fixesByAuditId[run.audit_id] ??= [];
      fixesByAuditId[run.audit_id]!.push(run);
    }
  }

  // Premium tab summarises every non-rule audit in this scan_run — including
  // the one you're currently viewing. Filtering out audit.id would hide the
  // current engine from its own summary when you click into it.
  const premiumSiblingsBase = reportAudits.filter(
    (row) => row.engine && row.engine !== "rule",
  ) as unknown as Omit<PremiumSibling, "topFindings">[];

  // Pull a handful of top-priority findings per sibling for inline display.
  // One round-trip via IN; we filter to fail/warn priorities ≤3 and slice
  // client-side because PostgREST doesn't do per-group LIMIT.
  let premiumSiblings: PremiumSibling[] = [];
  if (premiumSiblingsBase.length > 0) {
    const byAudit = new Map<
      string,
      { section: string; status: string; title: string; detail: string | null; priority: number }[]
    >();
    for (const sibling of premiumSiblingsBase) {
      const topFindings = (findingsByAuditId.get(sibling.id) ?? [])
        .filter(
          (f) =>
            (f.status === "fail" || f.status === "warn") && f.priority <= 3,
        )
        .slice(0, 4);
      const arr: {
        section: string;
        status: string;
        title: string;
        detail: string | null;
        priority: number;
      }[] = [];
      for (const f of topFindings) {
        arr.push({
          section: f.section,
          status: f.status,
          title: f.title,
          detail: f.detail ?? null,
          priority: f.priority,
        });
      }
      byAudit.set(sibling.id, arr);
    }
    premiumSiblings = premiumSiblingsBase.map((s) => ({
      ...s,
      topFindings: byAudit.get(s.id) ?? [],
    })) as PremiumSibling[];
  }

  // Diff branch
  if (diff) {
    const { data: other } = await supabase
      .from("audits")
      .select("id, target_url, status, score, summary, completed_at, created_at, owner_id")
      .eq("id", diff)
      .maybeSingle();
    if (other) {
      const { data: otherFindings } = await supabase
        .from("audit_findings")
        .select("section, check_key, status, title, detail, priority")
        .eq("audit_id", diff);
      return (
        <div className="space-y-6">
          <Link href={`/dashboard/audits/${id}`} className="text-sm text-[var(--color-muted)]">
            ← Back to report
          </Link>
          <DiffView
            current={{ audit: audit as AuditRow, findings: findings }}
            previous={{
              audit: other as AuditRow,
              findings: (otherFindings ?? []) as unknown as Finding[],
            }}
          />
        </div>
      );
    }
  }

  const ownerActions = (
    <div className="flex flex-col gap-2 sm:flex-row">
      {audit.share_token && (
        <CopyLink url={`${env.siteUrl}/r/${audit.share_token}`} />
      )}
      <PdfButton auditId={audit.id} />
    </div>
  );

  // Apply-Fix context: only available to the owner, on an audit attached
  // to a project, when the GitHub App is configured AND the user has at
  // least one installation with repos.
  let fixContext:
    | {
        projectId: string;
        auditId: string;
        repos: Array<{ full_name: string; installation_id: number }>;
        boundRepos: Array<{ full_name: string; installation_id: number }>;
        fixesByAuditId?: Record<string, FixRun[]>;
      }
    | undefined;
  if (user && (audit as { project_id?: string }).project_id) {
    fixContext = {
      projectId: (audit as { project_id: string }).project_id,
      auditId: audit.id,
      repos: [],
      boundRepos: [],
      fixesByAuditId,
    };
  }
  const ghConfigured = !!(env.githubAppId && env.githubAppPrivateKey);
  if (
    ghConfigured &&
    user &&
    (audit as { owner_id?: string }).owner_id === user.id &&
    (audit as { project_id?: string }).project_id
  ) {
    const { data: installs } = await supabase
      .from("github_installations")
      .select("installation_id")
      .is("removed_at", null);
    const repos: Array<{ full_name: string; installation_id: number }> = [];
    for (const i of (installs ?? []) as Array<{ installation_id: number }>) {
      try {
        const token = await getOrMintInstallationToken(i.installation_id);
        const list = await listInstallationRepos(token);
        for (const r of list) {
          repos.push({ full_name: r.full_name, installation_id: i.installation_id });
        }
      } catch {
        // Skip on token / API failure — the user can connect again later.
      }
    }
    const projectId = (audit as { project_id: string }).project_id;
    const { data: boundData } = await supabase
      .from("project_repos")
      .select("installation_id, repo_owner, repo_name")
      .eq("project_id", projectId);
    const boundRepos = ((boundData ?? []) as Array<{
      installation_id: number;
      repo_owner: string;
      repo_name: string;
    }>).map((b) => ({
      full_name: `${b.repo_owner}/${b.repo_name}`,
      installation_id: b.installation_id,
    }));
    fixContext = {
      projectId,
      auditId: audit.id,
      repos,
      boundRepos,
      fixesByAuditId,
    };
  }

  const publicShareUrl = audit.share_token
    ? `${env.siteUrl.replace(/\/$/, "")}/r/${audit.share_token}`
    : null;
  const scoreLabel =
    typeof audit.score === "number" ? `${audit.score}/100` : undefined;
  const markdown =
    audit.status === "complete" && audit.report_markdown
      ? ((await loadConsolidatedOrSoloMarkdown(supabase, {
          scan_run_id: audit.scan_run_id,
          target_url: audit.target_url,
          report_markdown: audit.report_markdown,
        })) ?? audit.report_markdown)
      : audit.report_markdown;
  const structuredReport =
    reportAudits.length > 1 ? (
      <MultiEngineReportView
        audits={reportAudits}
        findingsByAuditId={findingsByAuditId}
        ownerActions={ownerActions}
        fixContext={fixContext}
      />
    ) : (
      <ReportView
        audit={audit as AuditRow}
        findings={findings}
        ownerActions={ownerActions}
        fixContext={fixContext}
      />
    );

  return (
    <div className="space-y-6">
      {publicShareUrl && (
        <ShareBanner
          url={publicShareUrl}
          reportTitle={audit.target_url}
          scoreLabel={scoreLabel}
        />
      )}
      {audit.status !== "complete" && audit.status !== "failed" && (
        <LivePoller id={audit.id} />
      )}
      {audit.status === "complete" && audit.report_markdown ? (
        <ViewTabs
          rawMarkdownUrl={
            audit.share_token ? `/r/${audit.share_token}/prompt.md` : undefined
          }
          markdownView={<MarkdownView markdown={markdown ?? audit.report_markdown} />}
          structuredView={structuredReport}
          performanceView={
            premiumSiblings.length > 0 ? (
              <PremiumEngines siblings={premiumSiblings} />
            ) : (
              <PerformancePreview />
            )
          }
          performanceLabel={
            premiumSiblings.length > 0 ? "AI Engines" : "Performance"
          }
        />
      ) : (
        structuredReport
      )}
    </div>
  );
}
