// Vu1nz website scanner integration.
// API: POST https://vu1nz.com/api/v1/scan with { target }.
// Auth is optional; when the admin Vu1nz integration is configured, Vu1nz saves
// runs to its dashboard for the token owner.

import { getVu1nzApiToken } from "@/lib/platform-integrations";
import { scoreFindings } from "./score";
import type { AuditResult, CheckStatus, Finding } from "./types";

type Vu1nzAuditResult = AuditResult & { markdown: string };

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

function findingKey(input: unknown, index: number): string {
  if (!input || typeof input !== "object") return `vu1nz.web.${index}`;
  const row = input as Record<string, unknown>;
  const raw = row.check_key ?? row.key ?? row.id ?? row.rule_id ?? row.rule;
  const suffix = raw == null ? String(index) : String(raw);
  return `vu1nz.web.${suffix.replace(/[^a-z0-9_.-]/gi, "-")}`;
}

function toFinding(input: unknown, index: number): Finding {
  const severity = severityOf(input);
  return {
    section: SECTION,
    check_key: findingKey(input, index),
    status: statusForSeverity(severity),
    title: titleOf(input, index),
    detail: detailOf(input),
    evidence:
      input && typeof input === "object"
        ? { severity, ...((input as Record<string, unknown>) ?? {}) }
        : { severity, raw: input },
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

function responseFindings(response: Vu1nzScanResponse): Finding[] {
  const findings = (response.findings ?? []).map((f, i) => toFinding(f, i + 1));
  if (findings.length > 0) return findings;

  const webError = response.meta?.web_error;
  if (typeof webError === "string" && webError.trim()) {
    return [
      {
        section: SECTION,
        check_key: "vu1nz.web.fetch_error",
        status: "warn",
        title: "Vu1nz could not fetch the website",
        detail: webError,
        evidence: {
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
        check_key: "vu1nz.web.findings_summary",
        status: "warn",
        title: `Vu1nz reported ${total} website scanner finding${total === 1 ? "" : "s"}`,
        detail:
          "The Vu1nz API response included finding counts but did not include per-finding details.",
        evidence: {
          scan_id: response.scan_id,
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

function renderMarkdown(targetUrl: string, response: Vu1nzScanResponse, findings: Finding[]) {
  const counts = response.counts ?? {};
  const lines = [
    `# Vu1nz Security Assessment — ${targetUrl}`,
    "",
    `[Vu1nz](https://vu1nz.com) scanned this URL with its security assessment API.`,
    "",
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Total findings | ${response.total ?? findings.length} |`,
    countLine("Critical", counts.critical),
    countLine("High", counts.high),
    countLine("Medium", counts.medium),
    countLine("Low", counts.low),
    countLine("Info", counts.info),
    `| Duration | ${response.duration_ms ?? 0} ms |`,
  ];

  if (response.scan_id) lines.push(`| Vu1nz scan id | \`${response.scan_id}\` |`);
  if (response.dashboard_url) lines.push(`| Dashboard | ${response.dashboard_url} |`);

  lines.push("", "## Findings", "");

  if (findings.length === 0) {
    lines.push("✅ Vu1nz returned no website scanner findings for this URL.");
  } else {
    for (const f of findings) {
      lines.push(`### ${f.title}`, "");
      lines.push(`- Status: ${f.status}`);
      lines.push(`- Priority: P${f.priority}`);
      if (f.detail) lines.push(`- Detail: ${f.detail}`);
      lines.push("");
    }
  }

  if (response.meta && Object.keys(response.meta).length > 0) {
    lines.push("## Raw scanner metadata", "", "```json");
    lines.push(JSON.stringify(response.meta, null, 2));
    lines.push("```");
  }

  return lines.join("\n");
}

export async function vu1nzAudit(targetUrl: string): Promise<Vu1nzAuditResult> {
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

  let response: Vu1nzScanResponse;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({ target: targetUrl }),
    });
    response = (await res.json().catch(() => ({}))) as Vu1nzScanResponse;
    if (!res.ok || response.ok === false) {
      throw new Error(response.error || `Vu1nz API returned HTTP ${res.status}`);
    }
  } catch (err) {
    const findings: Finding[] = [
      {
        section: SECTION,
        check_key: "vu1nz.web.unavailable",
        status: "warn",
        title: "Vu1nz website scanner did not return results",
        detail: err instanceof Error ? err.message : String(err),
        evidence: { endpoint: ENDPOINT },
        priority: 3,
      },
    ];
    const summaryCounts = countsFromFindings(findings);
    return {
      score: scoreFindings(findings),
      findings,
      markdown: `# Vu1nz Security Assessment — ${targetUrl}\n\nCould not complete the Vu1nz scan: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
      summary: {
        pagesCrawled: 0,
        ...summaryCounts,
        dataFound: [],
        durationMs: Date.now() - started,
      },
    };
  }

  const findings = responseFindings(response);
  const summaryCounts = countsFromFindings(findings);
  return {
    score: findings.length === 0 ? 100 : scoreFindings(findings),
    findings,
    markdown: renderMarkdown(targetUrl, response, findings),
    summary: {
      pagesCrawled: 0,
      ...summaryCounts,
      dataFound: [
        {
          dataPoint: "Vu1nz scan id",
          found: Boolean(response.scan_id),
          source: response.scan_id ?? null,
          notes: response.dashboard_url ?? null,
        },
      ],
      durationMs: response.duration_ms ?? Date.now() - started,
    },
  };
}
