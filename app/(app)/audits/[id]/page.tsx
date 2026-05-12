import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ReportView, type AuditRow } from "@/components/report/report-view";
import { MarkdownView } from "@/components/report/markdown-view";
import { ViewTabs } from "@/components/report/view-tabs";
import { LivePoller } from "@/components/report/live-poller";
import { DiffView } from "@/components/report/diff-view";
import { CopyLink } from "@/components/copy-link";
import { PdfButton } from "@/components/pdf-button";
import type { Finding } from "@/lib/audit/types";
import { env } from "@/lib/env";

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
    .select("id, target_url, status, score, summary, report_markdown, completed_at, created_at, share_token, owner_id, project_id")
    .eq("id", id)
    .maybeSingle();
  if (!audit) notFound();
  if (audit.owner_id !== user!.id) notFound();

  const { data: findingsData } = await supabase
    .from("audit_findings")
    .select("section, check_key, status, title, detail, evidence, priority")
    .eq("audit_id", id);

  const findings = (findingsData ?? []) as unknown as Finding[];

  // Optional plan check for PDF.
  const { data: prof } = await supabase
    .from("profiles")
    .select("plan")
    .eq("id", user!.id)
    .maybeSingle();
  const plan = prof?.plan ?? "free";

  // Diff branch
  if (diff) {
    const { data: other } = await supabase
      .from("audits")
      .select("id, target_url, status, score, summary, completed_at, created_at, owner_id")
      .eq("id", diff)
      .maybeSingle();
    if (other && other.owner_id === user!.id) {
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
      <PdfButton auditId={audit.id} disabled={plan !== "pro"} />
    </div>
  );

  return (
    <div className="space-y-6">
      {audit.status !== "complete" && audit.status !== "failed" && (
        <LivePoller id={audit.id} />
      )}
      {audit.status === "complete" && audit.report_markdown ? (
        <ViewTabs
          rawMarkdownUrl={
            audit.share_token ? `/r/${audit.share_token}/report.md` : undefined
          }
          markdownView={<MarkdownView markdown={audit.report_markdown} />}
          structuredView={
            <ReportView
              audit={audit as AuditRow}
              findings={findings}
              ownerActions={ownerActions}
            />
          }
        />
      ) : (
        <ReportView
          audit={audit as AuditRow}
          findings={findings}
          ownerActions={ownerActions}
        />
      )}
    </div>
  );
}
