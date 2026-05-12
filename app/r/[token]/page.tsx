import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { ReportView, type AuditRow } from "@/components/report/report-view";
import { MarkdownView } from "@/components/report/markdown-view";
import { ViewTabs } from "@/components/report/view-tabs";
import { LivePoller } from "@/components/report/live-poller";
import { CopyLink } from "@/components/copy-link";
import { serviceClient } from "@/lib/supabase/service";
import type { Finding } from "@/lib/audit/types";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

type PublicAuditRow = AuditRow & { report_markdown: string | null };

export default async function PublicReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const svc = serviceClient();

  const { data: auditRows } = await svc.rpc("get_public_audit", { token });
  const audit = (auditRows as PublicAuditRow[] | null)?.[0];
  if (!audit) notFound();

  let findings: Finding[] = [];
  if (audit.status === "complete") {
    const { data } = await svc.rpc("get_public_findings", { token });
    findings = ((data as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
      section: r.section as string,
      check_key: r.check_key as string,
      status: r.status as Finding["status"],
      title: r.title as string,
      detail: (r.detail ?? undefined) as string | undefined,
      evidence: (r.evidence ?? {}) as Record<string, unknown>,
      priority: r.priority as Finding["priority"],
    }));
  }

  const ownerActions = (
    <div className="flex flex-col gap-2 sm:flex-row">
      <CopyLink url={`${env.siteUrl}/r/${token}`} />
    </div>
  );

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-6 py-10">
        {audit.status !== "complete" && audit.status !== "failed" && (
          <div className="mb-6">
            <LivePoller id={audit.id} />
          </div>
        )}
        {audit.status === "failed" && (
          <div className="card mb-6 p-5 text-[var(--color-fail)]">
            Audit failed. Please try again.
          </div>
        )}

        {audit.status === "complete" && audit.report_markdown ? (
          <ViewTabs
            rawMarkdownUrl={`/r/${token}/report.md`}
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
      </main>
      <SiteFooter />
    </>
  );
}
