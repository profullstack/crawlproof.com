// Vu1nz website scanner integration.
// API: POST https://vu1nz.com/api/v1/scan with { target }.
// Auth is optional; when the admin Vu1nz integration is configured, Vu1nz saves
// runs to its dashboard for the token owner.

import { getVu1nzApiToken } from "@/lib/platform-integrations";
import { scoreFindings } from "./score";
import type { AuditResult, CheckStatus, Finding } from "./types";

type Vu1nzAuditResult = AuditResult & { markdown: string };
type Vu1nzAuditOptions = {
  repoTargets?: string[];
  callbackUrl?: string;
};

type Vu1nzScanResponse = {
  ok?: boolean;
  scan_id?: string;
  target?: string;
  target_type?: string;
  checks_run?: string[];
  findings?: unknown[];
  counts?: Partial<Record<"critical" | "high" | "medium" | "low" | "info", number>>;
  total?: number;
  duration_ms?: number;
  meta?: Record<string, unknown>;
  dashboard_url?: string | null;
  error?: string;
};
type Vu1nzScan = {
  target: string;
  response: Vu1nzScanResponse;
  findings: Finding[];
};

const ENDPOINT = "https://vu1nz.com/api/v1/scan";
const SECTION = "Vu1nz Security Assessment";

function severityOf(input: unknown): string {
  if (!input || typeof input !== "object") return "info";
  const row = input as Record<string, unknown>;
  const raw =
    row.severity ??
    row.level ??
    row.priority ??
    row.impact ??
    row.risk ??
    "info";
  return String(raw).toLowerCase();
}

function statusForSeverity(severity: string): CheckStatus {
  if (severity === "critical" || severity === "high") return "fail";
  if (severity === "medium" || severity === "low") return "warn";
  if (severity === "info" || severity === "informational") return "unknown";
  return "warn";
}

function priorityForSeverity(severity: string): Finding["priority"] {
  if (severity === "critical") return 1;
  if (severity === "high") return 2;
  if (severity === "medium") return 3;
  if (severity === "low") return 4;
  return 5;
}

function titleOf(input: unknown, index: number): string {
  if (!input || typeof input !== "object") return `Vu1nz web finding ${index}`;
  const row = input as Record<string, unknown>;
  return String(
    row.title ??
      row.name ??
      row.check ??
      row.rule ??
      row.id ??
      `Vu1nz web finding ${index}`,
  );
}

function detailOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const row = input as Record<string, unknown>;
  const detail =
    row.detail ??
    row.description ??
    row.message ??
    row.remediation ??
    row.recommendation;
  return detail == null ? undefined : String(detail);
}

function targetSlug(target: string): string {
  return target.replace(/[^a-z0-9_.-]/gi, "-").replace(/-+/g, "-");
}

function findingKey(input: unknown, index: number, target: string): string {
  const prefix = `vu1nz.${targetSlug(target)}`;
  if (!input || typeof input !== "object") return `${prefix}.${index}`;
  const row = input as Record<string, unknown>;
  const raw = row.check_key ?? row.key ?? row.id ?? row.rule_id ?? row.rule;
  const suffix = raw == null ? String(index) : String(raw);
  return `${prefix}.${suffix.replace(/[^a-z0-9_.-]/gi, "-")}`;
}

function toFinding(input: unknown, index: number, response: Vu1nzScanResponse, target: string): Finding {
  const severity = severityOf(input);
  return {
    section: SECTION,
    check_key: findingKey(input, index, target),
    status: statusForSeverity(severity),
    title: titleOf(input, index),
    detail: detailOf(input),
    evidence:
      input && typeof input === "object"
        ? {
            scan_target: target,
            scan_id: response.scan_id ?? null,
            target_type: response.target_type ?? null,
            severity,
            ...((input as Record<string, unknown>) ?? {}),
          }
        : {
            scan_target: target,
            scan_id: response.scan_id ?? null,
            target_type: response.target_type ?? null,
            severity,
            raw: input,
          },
    priority: priorityForSeverity(severity),
  };
}

function countsFromFindings(findings: Finding[]) {
  return {
    pass: findings.filter((f) => f.status === "pass").length,
    warn: findings.filter((f) => f.status === "warn").length,
    fail: findings.filter((f) => f.status === "fail").length,
    unknown: findings.filter((f) => f.status === "unknown").length,
  };
}

function responseFindings(response: Vu1nzScanResponse, target: string): Finding[] {
  const findings = (response.findings ?? []).map((f, i) =>
    toFinding(f, i + 1, response, target),
  );
  if (findings.length > 0) return findings;

  const webError = response.meta?.web_error;
  if (typeof webError === "string" && webError.trim()) {
    return [
      {
        section: SECTION,
        check_key: `vu1nz.${targetSlug(target)}.fetch_error`,
        status: "warn",
        title: "Vu1nz could not fetch the website",
        detail: webError,
        evidence: {
          scan_target: target,
          scan_id: response.scan_id,
          meta: response.meta,
        },
        priority: 3,
      },
    ];
  }

  const total = Number(response.total ?? 0);
  if (total > 0) {
    return [
      {
        section: SECTION,
        check_key: `vu1nz.${targetSlug(target)}.findings_summary`,
        status: "warn",
        title: `Vu1nz reported ${total} website scanner finding${total === 1 ? "" : "s"}`,
        detail:
          "The Vu1nz API response included finding counts but did not include per-finding details.",
        evidence: {
          scan_target: target,
          scan_id: response.scan_id,
          target_type: response.target_type ?? null,
          counts: response.counts ?? {},
          dashboard_url: response.dashboard_url ?? null,
        },
        priority: 3,
      },
    ];
  }

  return [];
}

function countLine(label: string, value: unknown): string {
  const n = Number(value ?? 0);
  return `| ${label} | ${Number.isFinite(n) ? n : 0} |`;
}

function addCounts(
  out: Record<"critical" | "high" | "medium" | "low" | "info", number>,
  counts: Vu1nzScanResponse["counts"],
) {
  out.critical += Number(counts?.critical ?? 0);
  out.high += Number(counts?.high ?? 0);
  out.medium += Number(counts?.medium ?? 0);
  out.low += Number(counts?.low ?? 0);
  out.info += Number(counts?.info ?? 0);
}

function combinedCounts(scans: Vu1nzScan[]) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const scan of scans) addCounts(counts, scan.response.counts);
  return counts;
}

function renderMarkdown(targetUrl: string, scans: Vu1nzScan[], findings: Finding[]) {
  const counts = combinedCounts(scans);
  const totalDuration = scans.reduce((sum, scan) => sum + Number(scan.response.duration_ms ?? 0), 0);
  const lines = [
    `# Vu1nz Security Assessment — ${targetUrl}`,
    "",
    `[Vu1nz](https://vu1nz.com) scanned this URL with its security assessment API.`,
    "",
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Targets scanned | ${scans.length} |`,
    `| Total findings | ${scans.reduce((sum, scan) => sum + Number(scan.response.total ?? scan.findings.length), 0)} |`,
    countLine("Critical", counts.critical),
    countLine("High", counts.high),
    countLine("Medium", counts.medium),
    countLine("Low", counts.low),
    countLine("Info", counts.info),
    `| Duration | ${totalDuration} ms |`,
  ];

  lines.push("", "## Scan targets", "");
  for (const scan of scans) {
    const type = scan.response.target_type ?? (scan.target.includes("/") && !scan.target.startsWith("http") ? "repo" : "url");
    lines.push(
      `- \`${scan.target}\` (${type})${scan.response.scan_id ? ` — scan \`${scan.response.scan_id}\`` : ""}`,
    );
  }

  lines.push("", "## Findings", "");

  if (findings.length === 0) {
    lines.push("Vu1nz returned no security assessment findings for the scanned target(s).");
  } else {
    for (const f of findings) {
      lines.push(`### ${f.title}`, "");
      const scanTarget = f.evidence?.scan_target;
      if (scanTarget) lines.push(`- Target: ${scanTarget}`);
      lines.push(`- Status: ${f.status}`);
      lines.push(`- Priority: P${f.priority}`);
      if (f.detail) lines.push(`- Detail: ${f.detail}`);
      lines.push("");
    }
  }

  const metadata = scans
    .filter((scan) => scan.response.meta && Object.keys(scan.response.meta).length > 0)
    .map((scan) => ({ target: scan.target, meta: scan.response.meta }));
  if (metadata.length > 0) {
    lines.push("## Raw scanner metadata", "", "```json");
    lines.push(JSON.stringify(metadata, null, 2));
    lines.push("```");
  }

  return lines.join("\n");
}

async function postVu1nzScan(
  target: string,
  headers: Record<string, string>,
  callbackUrl?: string,
): Promise<Vu1nzScanResponse> {
  const body: Record<string, string> = { target };
  if (callbackUrl) body.callback_url = callbackUrl;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const response = (await res.json().catch(() => ({}))) as Vu1nzScanResponse;
  if (!res.ok || response.ok === false) {
    throw new Error(response.error || `Vu1nz API returned HTTP ${res.status}`);
  }
  return response;
}

export async function vu1nzAudit(
  targetUrl: string,
  options: Vu1nzAuditOptions = {},
): Promise<Vu1nzAuditResult> {
  const started = Date.now();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "user-agent": "CrawlProofBot/1.0 (+https://crawlproof.com/bot)",
  };
  const apiToken = await getVu1nzApiToken().catch((error) => {
    console.warn(
      "[vu1nz] could not load admin integration token",
      error instanceof Error ? error.message : error,
    );
    return null;
  });
  if (apiToken) {
    headers.Authorization = `Bearer ${apiToken}`;
  }

  const targets = [
    targetUrl,
    ...(options.repoTargets ?? []).filter((target) => target && !target.startsWith("http")),
  ];
  const scans: Vu1nzScan[] = [];
  const failures: Finding[] = [];
  try {
    for (const target of targets) {
      try {
        const response = await postVu1nzScan(target, headers, options.callbackUrl);
        const findings = responseFindings(response, target);
        scans.push({ target, response, findings });
      } catch (err) {
        failures.push({
          section: SECTION,
          check_key: `vu1nz.${targetSlug(target)}.unavailable`,
          status: "warn",
          title: "Vu1nz security assessment did not return results",
          detail: err instanceof Error ? err.message : String(err),
          evidence: { endpoint: ENDPOINT, scan_target: target },
          priority: 3,
        });
      }
    }
  } catch (err) {
    failures.push(
      {
        section: SECTION,
        check_key: "vu1nz.scan.unavailable",
        status: "warn",
        title: "Vu1nz security assessment did not return results",
        detail: err instanceof Error ? err.message : String(err),
        evidence: { endpoint: ENDPOINT },
        priority: 3,
      },
    );
  }

  const findings = [...scans.flatMap((scan) => scan.findings), ...failures];
  if (scans.length === 0) {
    const summaryCounts = countsFromFindings(findings);
    const detail =
      failures.map((f) => f.detail).filter(Boolean).join("\n") ||
      "No Vu1nz scan target returned results.";
    return {
      score: scoreFindings(findings),
      findings,
      markdown: `# Vu1nz Security Assessment — ${targetUrl}\n\nCould not complete the Vu1nz scan: ${detail}\n`,
      summary: {
        pagesCrawled: 0,
        ...summaryCounts,
        dataFound: [],
        durationMs: Date.now() - started,
      },
    };
  }

  const summaryCounts = countsFromFindings(findings);
  return {
    score: findings.length === 0 ? 100 : scoreFindings(findings),
    findings,
    markdown: renderMarkdown(targetUrl, scans, findings),
    summary: {
      pagesCrawled: 0,
      ...summaryCounts,
      dataFound: scans.map((scan) => ({
        dataPoint: `Vu1nz ${scan.response.target_type ?? "scan"} scan id`,
        found: Boolean(scan.response.scan_id),
        source: scan.response.scan_id ?? null,
        notes: scan.target,
      })),
      durationMs: scans.reduce(
        (sum, scan) => sum + Number(scan.response.duration_ms ?? 0),
        0,
      ) || Date.now() - started,
    },
  };
}
