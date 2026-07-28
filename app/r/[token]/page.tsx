import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import {
  MultiEngineReportView,
  ReportView,
  type AuditRow,
  type MultiEngineAuditRow,
} from "@/components/report/report-view";
import { MarkdownView } from "@/components/report/markdown-view";
import { ViewTabs } from "@/components/report/view-tabs";
import { PerformancePreview } from "@/components/report/performance-preview";
import { LivePoller } from "@/components/report/live-poller";
import { CopyLink } from "@/components/copy-link";
import { ShareBanner } from "@/components/share-banner";
import { EmailReportForm } from "@/components/report/email-report-form";
import { WatchForm } from "@/components/report/watch-form";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import type { Finding } from "@/lib/audit/types";
import { loadConsolidatedOrSoloMarkdown } from "@/lib/audit/summary-markdown";
import { buildShareCard } from "@/lib/audit/share-card";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

type PublicAuditRow = AuditRow & { report_markdown: string | null };

type SeoAudit = {
  target_url: string;
  status: string;
  score: number | null;
  completed_at: string | null;
  created_at: string;
  owner_id: string | null;
  engine: string | null;
  summary: Record<string, unknown> | null;
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function loadSeoAudit(token: string): Promise<SeoAudit | null> {
  const svc = serviceClient();
  const { data } = await svc
    .from("audits")
    .select("target_url, status, score, completed_at, created_at, owner_id, engine, summary")
    .eq("share_token", token)
    .maybeSingle();
  return (data as SeoAudit | null) ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const audit = await loadSeoAudit(token);
  if (!audit) {
    return {
      title: "Audit not found",
      robots: { index: false, follow: false },
    };
  }

  const host = hostOf(audit.target_url);
  const isAnonymous = !audit.owner_id;
  const url = `${env.siteUrl.replace(/\/$/, "")}/r/${token}`;

  // Anonymous free scans → indexable, full SEO. Owner-attributed (paid)
  // reports may contain customer info — keep them off the index.
  const robots: Metadata["robots"] = isAnonymous
    ? { index: true, follow: true, googleBot: { index: true, follow: true } }
    : { index: false, follow: false, googleBot: { index: false, follow: false } };

  // Derive the headline from the same model the OG card renders, so the text
  // preview and the image can never disagree. They would otherwise: for a slop
  // scan the headline number lives in `summary.slopScore` (0 = pristine) while
  // `audits.score` holds the conventional AEO-style score, so a naive title
  // showed "78/100" beside a card reading "34/100".
  const card = buildShareCard(audit);
  const complete = card.state === "complete" && card.score !== null;
  const stateSuffix = card.state === "failed" ? " — Failed" : " — Running";

  const title = complete
    ? card.kind === "slop"
      ? `Slop Score ${card.score}/100 for ${host}`
      : `AEO audit for ${host} — Score ${card.score}/100`
    : card.kind === "slop"
      ? `Slop Score for ${host}${stateSuffix}`
      : `AEO audit for ${host}${stateSuffix}`;

  const description = complete
    ? card.kind === "slop"
      ? `${host} scored ${card.score}/100 on the CrawlProof Slop Score, where 0 is pristine — ${card.headline}. A free sweep for observable defects: placeholder copy, near-duplicate pages, leaked template variables, stale dates, and design drift.`
      : `AEO audit for ${host} scored ${card.score}/100. See exactly what AI crawlers — GPTBot, ClaudeBot, PerplexityBot, Google-Extended — can find on the site, plus a prioritised to-do list of fixes.`
    : `AEO audit for ${host} from CrawlProof. See what AI crawlers can find on the site.`;

  return {
    title,
    description,
    alternates: { canonical: url },
    robots,
    openGraph: {
      type: "article",
      url,
      title,
      description,
      siteName: "CrawlProof",
      publishedTime: audit.created_at,
      modifiedTime: audit.completed_at ?? audit.created_at,
      // No `images` here on purpose. Declaring one would override the
      // generated per-report card in ./opengraph-image.tsx and put every
      // report back on the identical static banner. The file convention
      // supplies og:image, its dimensions, and the alt text.
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      // Same reason — the card file feeds twitter:image too.
    },
    other: {
      "article:section": "AEO Audit",
      "article:tag": "AEO, LLM, GPTBot, ClaudeBot, PerplexityBot",
    },
  };
}

function ReportJsonLd({
  url,
  audit,
}: {
  url: string;
  audit: SeoAudit;
}) {
  const host = hostOf(audit.target_url);
  const score = audit.score;
  const data = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: `AEO audit for ${host}${score !== null ? ` — Score ${score}/100` : ""}`,
    description: `Public Answer Engine Optimization audit for ${host} produced by CrawlProof. Covers crawlability, schema, robots.txt, AI-bot accessibility, positioning, and a priority to-do checklist.`,
    url,
    inLanguage: "en",
    datePublished: audit.created_at,
    dateModified: audit.completed_at ?? audit.created_at,
    author: { "@type": "Organization", name: "CrawlProof", url: env.siteUrl },
    publisher: {
      "@type": "Organization",
      name: "CrawlProof",
      url: env.siteUrl,
      logo: { "@type": "ImageObject", url: `${env.siteUrl}/icon` },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    about: { "@type": "WebSite", url: audit.target_url, name: host },
    ...(score !== null && {
      additionalProperty: {
        "@type": "PropertyValue",
        name: "AEO score",
        value: score,
        unitText: "out of 100",
      },
    }),
  };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export default async function PublicReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const svc = serviceClient();

  // Track viewer auth so we can gate the LLM-ready prompt download to
  // registered users while keeping the structured report itself public.
  const session = await createClient();
  const {
    data: { user: viewer },
  } = await session.auth.getUser();
  const viewerSignedIn = !!viewer;

  const { data: auditRows } = await svc.rpc("get_public_audit", { token });
  const audit = (auditRows as PublicAuditRow[] | null)?.[0];
  if (!audit) notFound();

  // The public RPC doesn't surface scan_run_id (intentionally — owner
  // metadata). Pull it via the share_token so we can collapse siblings
  // into the same consolidated Markdown the prompt.md download uses.
  const { data: scanLink } = await svc
    .from("audits")
    .select("scan_run_id")
    .eq("share_token", token)
    .maybeSingle();
  const auditScanRunId = (scanLink?.scan_run_id ?? null) as string | null;
  const { data: scanRunAuditsData } = auditScanRunId
    ? await svc
        .from("audits")
        .select(
          "id, target_url, status, score, summary, completed_at, created_at, share_token, engine, failed_reason",
        )
        .eq("scan_run_id", auditScanRunId)
        .order("created_at", { ascending: true })
    : { data: null };
  const reportAudits =
    ((scanRunAuditsData ?? []) as unknown as MultiEngineAuditRow[]).length > 0
      ? ((scanRunAuditsData ?? []) as unknown as MultiEngineAuditRow[])
      : [audit as MultiEngineAuditRow];
  const reportAuditIds = reportAudits.map((row) => row.id);

  const seo = await loadSeoAudit(token);
  // Same model the OG card uses, so the watch form names the same score the
  // visitor is looking at (slop and AEO differ).
  const watchCard = buildShareCard(
    seo ?? { target_url: audit.target_url, status: audit.status, score: audit.score, engine: null },
  );
  const canonicalUrl = `${env.siteUrl.replace(/\/$/, "")}/r/${token}`;

  const findingsByAuditId = new Map<string, Finding[]>();
  if (reportAuditIds.length > 0) {
    const { data } = await svc
      .from("audit_findings")
      .select("audit_id, section, check_key, status, title, detail, evidence, priority")
      .in("audit_id", reportAuditIds)
      .order("priority", { ascending: true });
    for (const row of (data ?? []) as Array<Finding & { audit_id: string }>) {
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
  }
  const findings = findingsByAuditId.get(audit.id) ?? [];

  const ownerActions = (
    <div className="flex flex-col gap-2 sm:flex-row">
      <CopyLink url={canonicalUrl} />
    </div>
  );
  const structuredReport =
    reportAudits.length > 1 ? (
      <MultiEngineReportView
        audits={reportAudits}
        findingsByAuditId={findingsByAuditId}
        ownerActions={ownerActions}
      />
    ) : (
      <ReportView
        audit={audit as AuditRow}
        findings={findings}
        ownerActions={ownerActions}
      />
    );

  return (
    <>
      {seo && <ReportJsonLd url={canonicalUrl} audit={seo} />}
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-10">
        <ShareBanner
          url={canonicalUrl}
          reportTitle={audit.target_url}
          scoreLabel={
            typeof audit.score === "number" ? `${audit.score}/100` : undefined
          }
        />
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
            rawMarkdownUrl={viewerSignedIn ? `/r/${token}/prompt.md` : undefined}
            markdownView={
              <MarkdownView
                markdown={
                  // Use the same consolidated/solo logic as the
                  // /r/<token>/prompt.md download so the on-page Report
                  // tab matches what the user grabs via Download.
                  (await loadConsolidatedOrSoloMarkdown(svc, {
                    scan_run_id: auditScanRunId,
                    target_url: audit.target_url,
                    report_markdown: audit.report_markdown,
                  })) ?? audit.report_markdown
                }
              />
            }
            structuredView={
              structuredReport
            }
            performanceView={<PerformancePreview />}
          />
        ) : (
          structuredReport
        )}

        {audit.status !== "failed" && (
          <div className="mt-8 grid gap-4 lg:grid-cols-2">
            <EmailReportForm
              token={token}
              complete={audit.status === "complete"}
            />
            {/* The recurring capture sits beside the one-shot PDF ask: the PDF
                ends the conversation, the watch continues it. */}
            {seo && (
              <WatchForm
                token={token}
                host={watchCard.host}
                label={watchCard.label}
              />
            )}
          </div>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
