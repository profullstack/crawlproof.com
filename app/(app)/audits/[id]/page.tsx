import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ReportView, type AuditRow } from "@/components/report/report-view";
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
          .maybeSingle();
        isMember = !!orgMemberCheck;
      }
    }
  }
  if (!isOwner && !isMember) notFound();

  // Premium tab summarises EVERY non-rule audit in this scan_run — including
  // the one you're currently viewing. Filtering out audit.id would hide the
  // current engine from its own summary when you click into it.
  const { data: siblingsData } = audit.scan_run_id
    ? await supabase
        .from("audits")
        .select(
          "id, engine, status, score, share_token, failed_reason, completed_at, summary",
        )
        .eq("scan_run_id", audit.scan_run_id)
        .neq("engine", "rule")
        .order("created_at", { ascending: true })
    : { data: null };
  const premiumSiblingsBase = (siblingsData ?? []) as unknown as Omit<
    PremiumSibling,
    "topFindings"
  >[];

  // Pull a handful of top-priority findings per sibling for inline display.
  // One round-trip via IN; we filter to fail/warn priorities ≤3 and slice
  // client-side because PostgREST doesn't do per-group LIMIT.
  let premiumSiblings: PremiumSibling[] = [];
  if (premiumSiblingsBase.length > 0) {
    const siblingIds = premiumSiblingsBase.map((s) => s.id);
    const { data: findingsForSiblings } = await supabase
      .from("audit_findings")
      .select("audit_id, section, status, title, detail, priority")
      .in("audit_id", siblingIds)
      .in("status", ["fail", "warn"])
      .lte("priority", 3)
      .order("priority", { ascending: true });
    const byAudit = new Map<
      string,
      { section: string; status: string; title: string; detail: string | null; priority: number }[]
    >();
    for (const f of findingsForSiblings ?? []) {
      const arr = byAudit.get(f.audit_id as string) ?? [];
      if (arr.length < 4) {
        arr.push({
          section: f.section as string,
          status: f.status as string,
          title: f.title as string,
          detail: (f.detail as string | null) ?? null,
          priority: f.priority as number,
        });
      }
      byAudit.set(f.audit_id as string, arr);
    }
    premiumSiblings = premiumSiblingsBase.map((s) => ({
      ...s,
      topFindings: byAudit.get(s.id) ?? [],
    })) as PremiumSibling[];
  }

  const { data: findingsData } = await supabase
    .from("audit_findings")
    .select("section, check_key, status, title, detail, evidence, priority")
    .eq("audit_id", id);

  const findings = (findingsData ?? []) as unknown as Finding[];

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
          <Link href={`/audits/${id}`} className="text-sm text-[var(--color-muted)]">
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
      }
    | undefined;
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
    };
  }

  const publicShareUrl = audit.share_token
    ? `${env.siteUrl.replace(/\/$/, "")}/r/${audit.share_token}`
    : null;
  const scoreLabel =
    typeof audit.score === "number" ? `${audit.score}/100` : undefined;

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
          markdownView={<MarkdownView markdown={audit.report_markdown} />}
          structuredView={
            <ReportView
              audit={audit as AuditRow}
              findings={findings}
              ownerActions={ownerActions}
              fixContext={fixContext}
            />
          }
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
        <ReportView
          audit={audit as AuditRow}
          findings={findings}
          ownerActions={ownerActions}
          fixContext={fixContext}
        />
      )}
    </div>
  );
}
