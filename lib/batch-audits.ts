// Batch audits (R4) and the rankings built from them (R5).
//
// A batch is a set of rule-engine audits created together under one
// batch_id, tagged with the funnel source their links will be sent through
// (outreach emails or a public ranking). Batch audits never count as
// self-run audits in the funnel, and outreach ones stay off search engines.

import crypto from "node:crypto";
import { serviceClient } from "@/lib/supabase/service";
import { isAllowedTargetUrl } from "@/lib/rateLimit";
import { newShareToken } from "@/lib/shareToken";
import { topFixes } from "@/lib/audit/top-fixes";
import type { Finding } from "@/lib/audit/types";
import { env } from "@/lib/env";

// Per request. The audit worker shares the site's container and runs every
// queued audit at once: 80 in one go OOM-killed crawlproof.com (2026-11-18).
export const BATCH_MAX = 20;
export type BatchSource = "outreach" | "ranking";

export function isBatchSource(v: unknown): v is BatchSource {
  return v === "outreach" || v === "ranking";
}

/** Turn "acme.com", "https://acme.com/" and the like into an auditable URL. Pure. */
export function domainToUrl(raw: string): string {
  const s = raw.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function base(): string {
  return (env.siteUrl || "https://crawlproof.com").replace(/\/$/, "");
}

export function reportLink(token: string, source: BatchSource): string {
  return `${base()}/r/${token}?src=${source}`;
}

export async function createBatch(input: {
  domains: string[];
  source: BatchSource;
  batchId?: string | null;
}): Promise<{
  batchId: string;
  created: { domain: string; url: string; token: string }[];
  rejected: { domain: string; reason: string }[];
}> {
  const svc = serviceClient();
  const batchId = input.batchId ?? crypto.randomUUID();
  // Lazy: lib/orgs is server-only, and the pure helpers below are unit-tested.
  const { getProspectsOrgId } = await import("@/lib/orgs");
  const prospectsOrgId = await getProspectsOrgId().catch(() => null);
  const created: { domain: string; url: string; token: string }[] = [];
  const rejected: { domain: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const domain of input.domains.slice(0, BATCH_MAX)) {
    const check = isAllowedTargetUrl(domainToUrl(domain));
    if (!check.ok) {
      rejected.push({ domain, reason: check.reason });
      continue;
    }
    if (seen.has(check.url)) continue;
    seen.add(check.url);
    const token = newShareToken();
    const { data, error } = await svc
      .from("audits")
      .insert({
        target_url: check.url,
        owner_id: null,
        organization_id: prospectsOrgId,
        status: "queued",
        share_token: token,
        triggered_by: "manual",
        engine: "rule",
        funnel_source: input.source,
        batch_id: batchId,
        // A ranking is public by design; outreach reports are private to
        // whoever holds the link.
        listed_public: input.source === "ranking",
      })
      .select("id")
      .single();
    if (error || !data) {
      rejected.push({ domain, reason: error?.message ?? "insert failed" });
      continue;
    }
    created.push({ domain, url: check.url, token });
    if (env.workerUrl) {
      await fetch(`${env.workerUrl}/enqueue`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": env.workerSecret },
        body: JSON.stringify({ auditId: data.id }),
      }).catch(() => {});
    }
  }
  return { batchId, created, rejected };
}

export type BatchRow = {
  domain: string;
  target_url: string;
  status: string;
  score: number | null;
  top_issue: string;
  report_url: string;
  token: string;
  completed_at: string | null;
};

/** hostname without www, for the CSV's domain column and the ranking. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Every audit in a batch with its top issue; the latest run per site wins. */
export async function readBatch(batchId: string): Promise<BatchRow[]> {
  const svc = serviceClient();
  const { data: audits } = await svc
    .from("audits")
    .select("id, target_url, status, score, share_token, funnel_source, completed_at, created_at")
    .eq("batch_id", batchId)
    .order("created_at", { ascending: false })
    .limit(1000);
  const latest = new Map<string, Record<string, unknown>>();
  for (const a of (audits ?? []) as Record<string, unknown>[]) {
    const key = a.target_url as string;
    if (!latest.has(key)) latest.set(key, a);
  }
  const rows = [...latest.values()];
  const ids = rows.filter((a) => a.status === "complete").map((a) => a.id as string);
  const findingsBy = new Map<string, Finding[]>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await svc
      .from("audit_findings")
      .select("audit_id, section, check_key, status, title, detail, priority")
      .in("audit_id", ids.slice(i, i + 100));
    for (const f of (data ?? []) as (Finding & { audit_id: string })[]) {
      const list = findingsBy.get(f.audit_id) ?? [];
      list.push(f);
      findingsBy.set(f.audit_id, list);
    }
  }
  return rows.map((a) => {
    const source = isBatchSource(a.funnel_source) ? a.funnel_source : "outreach";
    const top = topFixes(findingsBy.get(a.id as string) ?? [], 1)[0];
    return {
      domain: hostOf(a.target_url as string),
      target_url: a.target_url as string,
      status: a.status as string,
      score: (a.score as number | null) ?? null,
      top_issue: top?.title ?? "",
      report_url: reportLink(a.share_token as string, source),
      token: a.share_token as string,
      completed_at: (a.completed_at as string | null) ?? null,
    };
  });
}

/** Ranking order: highest score first, unscored last, ties by domain. Pure. */
export function rankRows<T extends { score: number | null; domain: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.score === null && b.score === null) return a.domain.localeCompare(b.domain);
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score || a.domain.localeCompare(b.domain);
  });
}
