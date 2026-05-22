import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { ReportView, type AuditRow } from "@/components/report/report-view";
import { MarkdownView } from "@/components/report/markdown-view";
import { ViewTabs } from "@/components/report/view-tabs";
import { PerformancePreview } from "@/components/report/performance-preview";
import { LivePoller } from "@/components/report/live-poller";
import { CopyLink } from "@/components/copy-link";
import { ShareBanner } from "@/components/share-banner";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import type { Finding } from "@/lib/audit/types";
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
    .select("target_url, status, score, completed_at, created_at, owner_id, engine")
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

  const scoreLabel =
    audit.status === "complete" && audit.score !== null
      ? ` — Score ${audit.score}/100`
      : audit.status === "failed"
        ? " — Failed"
        : audit.status === "queued" || audit.status === "running"
          ? " — Running"
          : "";

  const description =
    audit.status === "complete" && audit.score !== null
      ? `AEO audit for ${host} scored ${audit.score}/100. See exactly what AI crawlers — GPTBot, ClaudeBot, PerplexityBot, Google-Extended — can find on the site, plus a prioritised to-do list of fixes.`
      : `AEO audit for ${host} from CrawlProof. See what AI crawlers can find on the site.`;

  return {
    title: `AEO audit for ${host}${scoreLabel}`,
    description,
    alternates: { canonical: url },
    robots,
    openGraph: {
      type: "article",
      url,
      title: `AEO audit for ${host}${scoreLabel}`,
      description,
      siteName: "CrawlProof",
      publishedTime: audit.created_at,
      modifiedTime: audit.completed_at ?? audit.created_at,
      // Page-level openGraph replaces the layout block wholesale — no
      // merging — so the banner has to be re-declared here or X/social
      // previews end up with no thumbnail.
      images: [
        {
          url: "/banner.png",
          width: 1200,
          height: 630,
          alt: `CrawlProof AEO audit for ${host}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `AEO audit for ${host}${scoreLabel}`,
      description,
      images: ["/banner.png"],
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

  const seo = await loadSeoAudit(token);
  const canonicalUrl = `${env.siteUrl.replace(/\/$/, "")}/r/${token}`;

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
      <CopyLink url={canonicalUrl} />
    </div>
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
            markdownView={<MarkdownView markdown={audit.report_markdown} />}
            structuredView={
              <ReportView
                audit={audit as AuditRow}
                findings={findings}
                ownerActions={ownerActions}
              />
            }
            performanceView={<PerformancePreview />}
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
