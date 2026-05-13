import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { ScanRunResults, type RunAudit } from "@/components/scan-run-results";
import { ENGINES, type Engine } from "@/lib/credits";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

type AuditRow = RunAudit & { target_url: string; owner_id: string | null };

async function loadRun(runId: string): Promise<AuditRow[] | null> {
  const svc = serviceClient();
  const { data } = await svc
    .from("audits")
    .select(
      "id, engine, status, score, share_token, failed_reason, completed_at, summary, created_at, target_url, owner_id",
    )
    .eq("scan_run_id", runId)
    .order("created_at", { ascending: true });
  const rows = (data ?? []) as AuditRow[];
  return rows.length > 0 ? rows : null;
}

function isFreeRun(rows: AuditRow[]): boolean {
  // A run is publicly visible only when every engine is free (rule).
  // Any paid engine means it's a customer-paid report and stays private.
  return rows.every((r) => (ENGINES[r.engine as Engine]?.cost ?? 0) === 0);
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ runId: string }>;
}): Promise<Metadata> {
  const { runId } = await params;
  const rows = await loadRun(runId);
  if (!rows || !isFreeRun(rows)) {
    return {
      title: "Scan run not found",
      robots: { index: false, follow: false },
    };
  }
  const host = hostOf(rows[0].target_url);
  const completed = rows.filter((r) => r.status === "complete" && r.score !== null);
  const avg =
    completed.length > 0
      ? Math.round(
          completed.reduce((s, r) => s + (r.score ?? 0), 0) / completed.length,
        )
      : null;
  const url = `${env.siteUrl.replace(/\/$/, "")}/runs/${runId}`;
  const title =
    avg !== null
      ? `AEO scan run for ${host} — avg ${avg}/100`
      : `AEO scan run for ${host}`;
  const description = `Free CrawlProof scan run for ${host} across ${rows.length} engine${rows.length === 1 ? "" : "s"}.`;
  return {
    title,
    description,
    alternates: { canonical: url },
    // Anonymous (owner-less) free runs are fully public — index them.
    // Owner-attributed free runs still expose to anyone with the URL but
    // we keep them out of the index to avoid surfacing customer URLs.
    robots: rows.some((r) => r.owner_id)
      ? { index: false, follow: false }
      : { index: true, follow: true },
    openGraph: {
      type: "article",
      url,
      title,
      description,
      siteName: "CrawlProof",
    },
  };
}

export default async function PublicScanRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const rows = await loadRun(runId);
  if (!rows) notFound();
  if (!isFreeRun(rows)) notFound();

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-10">
        <ScanRunResults
          rows={rows}
          targetUrl={rows[0].target_url}
        />
      </main>
      <SiteFooter />
    </>
  );
}
