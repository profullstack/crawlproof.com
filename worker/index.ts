import http from "node:http";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";
import { runAudit } from "../lib/audit/engine";
import { claudeAudit } from "../lib/audit/claude-engine";
import { openaiAudit } from "../lib/audit/openai-engine";
import { geminiAudit } from "../lib/audit/gemini-engine";
import { qwenAudit } from "../lib/audit/qwen-engine";
import { kimiAudit } from "../lib/audit/kimi-engine";
import { deepseekAudit } from "../lib/audit/deepseek-engine";
import { toMarkdown } from "../lib/audit/markdown";
import { Resend } from "resend";
import { renderPdf, renderPdfFromHtml } from "./pdf";
import { markdownToHtml, htmlDocument } from "../lib/markdown";
import { auditReadyEmailHtml, scanRunSummaryEmailHtml, type SummaryEngineRow } from "../lib/email";
import { ENGINES, type Engine } from "../lib/credits";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sharedSecret = process.env.WORKER_SHARED_SECRET ?? "";
// WORKER_PORT is for in-container loopback (Next.js POSTs jobs to /enqueue).
// Fall back to PORT only when the worker runs as a separate Railway service.
const port = Number(process.env.WORKER_PORT ?? process.env.PORT ?? 8080);
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Playwright base image ships Node 20 — supabase-js v2 needs a WebSocket
// transport on Node <22, even though we never subscribe to realtime.
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
});
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

type Job = { auditId: string; pdfEmail?: string };

async function processJob(job: Job) {
  const { auditId } = job;
  console.log(`[worker] running audit ${auditId}`);

  const { data: audit, error } = await supabase
    .from("audits")
    .select("id, target_url, owner_id, engine, pdf_email, scan_run_id, project_id")
    .eq("id", auditId)
    .maybeSingle();
  if (error || !audit) {
    console.error("[worker] audit not found", auditId, error);
    return;
  }
  // Fall back to the persisted column when the HTTP enqueue payload didn't
  // carry one (e.g. the sweep loop, or older enqueue bodies).
  const pdfEmail = job.pdfEmail ?? (audit.pdf_email as string | null) ?? undefined;

  await supabase
    .from("audits")
    .update({ status: "running" })
    .eq("id", auditId);

  try {
    // Engine dispatch:
    //   'rule'   — local rule-based crawler (default for anonymous/free)
    //   'claude' — Claude Opus 4.7 + web tools (1 credit)
    //   'openai' — OpenAI GPT-5 + web search (1 credit)
    const engine =
      (audit.engine as
        | "rule"
        | "claude"
        | "openai"
        | "gemini"
        | "qwen"
        | "kimi"
        | "deepseek") ?? "rule";
    console.log(`[worker] audit ${auditId} engine=${engine}`);

    let score: number;
    let summary: unknown;
    let findings: Array<{
      section: string;
      check_key: string;
      status: string;
      title: string;
      detail?: string;
      evidence?: Record<string, unknown>;
      priority: number;
    }>;
    let markdown: string;

    const llmEngines = {
      claude: claudeAudit,
      openai: openaiAudit,
      gemini: geminiAudit,
      qwen: qwenAudit,
      kimi: kimiAudit,
      deepseek: deepseekAudit,
    } as const;

    if (engine in llmEngines) {
      const fn = llmEngines[engine as keyof typeof llmEngines];
      const r = await fn(audit.target_url);
      score = r.score;
      summary = r.summary;
      findings = r.findings;
      markdown = r.markdown;
    } else {
      const r = await runAudit(audit.target_url);
      score = r.score;
      summary = r.summary;
      findings = r.findings;
      markdown = toMarkdown({ targetUrl: audit.target_url, score: r.score, result: r });
    }

    // Insert findings.
    const rows = findings.map((f) => ({
      audit_id: auditId,
      section: f.section,
      check_key: f.check_key,
      status: f.status,
      title: f.title,
      detail: f.detail ?? null,
      evidence: f.evidence ?? {},
      priority: f.priority,
    }));
    if (rows.length > 0) {
      const { error: insErr } = await supabase.from("audit_findings").insert(rows);
      if (insErr) console.error("[worker] findings insert", insErr);
    }

    // Mark complete.
    await supabase
      .from("audits")
      .update({
        status: "complete",
        score,
        summary,
        report_markdown: markdown,
        completed_at: new Date().toISOString(),
      })
      .eq("id", auditId);

    console.log(`[worker] audit ${auditId} complete, score=${score}`);

    // Email path. Solo scans get a per-engine PDF; multi-engine scans get
    // ONE summary email after every sibling reaches a terminal state.
    if (pdfEmail) {
      if (!resend) {
        console.warn(
          `[worker] audit ${auditId}: pdfEmail=${pdfEmail} requested but RESEND_API_KEY is not set; skipping`,
        );
      } else {
        try {
          await maybeSendEmail({
            auditId,
            scanRunId: audit.scan_run_id as string | null,
            projectId: audit.project_id as string | null,
            pdfEmail,
            score,
            markdown,
            targetUrl: audit.target_url,
          });
        } catch (err) {
          console.error("[worker] email step failed", err);
        }
      }
    }
  } catch (err) {
    console.error("[worker] audit failed", auditId, err);
    await supabase
      .from("audits")
      .update({
        status: "failed",
        failed_reason: err instanceof Error ? err.message : String(err),
      })
      .eq("id", auditId);
  }
}

type SiblingRow = {
  id: string;
  engine: string;
  status: string;
  score: number | null;
  share_token: string | null;
  summary: { pass?: number; warn?: number; fail?: number } | null;
  report_markdown: string | null;
  failed_reason: string | null;
  created_at: string;
};

function buildSummaryMarkdown(input: {
  targetUrl: string;
  rows: SiblingRow[];
  avgScore: number | null;
}): string {
  const { targetUrl, rows, avgScore } = input;
  const host = (() => {
    try { return new URL(targetUrl).hostname; } catch { return targetUrl; }
  })();
  const generated = new Date().toISOString();

  const tableRows = rows
    .map((r) => {
      const meta = ENGINES[r.engine as Engine];
      const label = meta?.label ?? r.engine;
      const scoreCell =
        r.status === "complete" && r.score !== null ? `${r.score}/100` : r.status;
      const p = r.summary?.pass ?? 0;
      const w = r.summary?.warn ?? 0;
      const f = r.summary?.fail ?? 0;
      return `| ${label} | ${scoreCell} | ${p} | ${w} | ${f} |`;
    })
    .join("\n");

  const exec = [
    `# AEO Audit — ${host}`,
    ``,
    `**Target:** ${targetUrl}`,
    ``,
    `**Generated:** ${generated}`,
    ``,
    `**Engines:** ${rows.length}${avgScore !== null ? ` · **Average score:** ${avgScore}/100` : ""}`,
    ``,
    `## Executive Summary`,
    ``,
    `| Engine | Score | Pass | Warn | Fail |`,
    `|---|---:|---:|---:|---:|`,
    tableRows,
    ``,
    avgScore !== null
      ? `Average score: **${avgScore}/100** across ${rows.length} engine${rows.length === 1 ? "" : "s"}.`
      : `${rows.length} engine${rows.length === 1 ? "" : "s"} run.`,
    ``,
    `---`,
    ``,
  ].join("\n");

  const perEngine = rows
    .map((r) => {
      const meta = ENGINES[r.engine as Engine];
      const label = meta?.label ?? r.engine;
      if (r.status === "failed") {
        return [
          `## ${label}`,
          ``,
          `_Engine failed: ${r.failed_reason ?? "unknown reason"}_`,
          ``,
          `---`,
          ``,
        ].join("\n");
      }
      if (!r.report_markdown) {
        return [`## ${label}`, ``, `_Report unavailable._`, ``, `---`, ``].join("\n");
      }
      return [
        `## Engine: ${label}`,
        ``,
        r.report_markdown,
        ``,
        `---`,
        ``,
      ].join("\n");
    })
    .join("\n");

  return exec + perEngine;
}

// Route the audit-complete email. Solo scans (single audit in the
// scan_run) get the existing per-engine PDF; multi-engine runs get one
// summary email after every sibling reaches a terminal state, sent by
// whichever worker wins the atomic claim on summary_email_sent_at.
async function maybeSendEmail(input: {
  auditId: string;
  scanRunId: string | null;
  projectId: string | null;
  pdfEmail: string;
  score: number;
  markdown: string;
  targetUrl: string;
}): Promise<void> {
  const { auditId, scanRunId, projectId, pdfEmail, score, markdown, targetUrl } = input;

  // No scan_run_id (legacy row or anonymous): always per-engine.
  if (!scanRunId) {
    await sendPerEngineEmail({ auditId, pdfEmail, score, markdown, targetUrl });
    return;
  }

  const { data: siblings } = await supabase
    .from("audits")
    .select(
      "id, engine, status, score, share_token, summary, report_markdown, failed_reason, created_at",
    )
    .eq("scan_run_id", scanRunId)
    .order("created_at", { ascending: true });
  const rows = (siblings ?? []) as SiblingRow[];

  if (rows.length <= 1) {
    await sendPerEngineEmail({ auditId, pdfEmail, score, markdown, targetUrl });
    return;
  }

  const allTerminal = rows.every(
    (r) => r.status === "complete" || r.status === "failed",
  );
  if (!allTerminal) {
    console.log(
      `[worker] scan_run ${scanRunId}: ${rows.filter((r) => r.status !== "complete" && r.status !== "failed").length} sibling(s) still running; deferring summary email`,
    );
    return;
  }

  // Atomic claim. Only the row with the smallest created_at in the run is
  // eligible — the WHERE on summary_email_sent_at IS NULL gates concurrent
  // workers so exactly one update wins.
  const claimRowId = rows[0].id;
  const { data: claimed, error: claimErr } = await supabase
    .from("audits")
    .update({ summary_email_sent_at: new Date().toISOString() })
    .eq("id", claimRowId)
    .is("summary_email_sent_at", null)
    .select("id")
    .maybeSingle();
  if (claimErr) {
    console.error("[worker] summary email claim error", claimErr);
    return;
  }
  if (!claimed) {
    console.log(
      `[worker] scan_run ${scanRunId}: summary email already claimed by another worker; skipping`,
    );
    return;
  }

  await sendSummaryEmail({ scanRunId, projectId, pdfEmail, targetUrl, rows });
}

async function sendPerEngineEmail(input: {
  auditId: string;
  pdfEmail: string;
  score: number;
  markdown: string;
  targetUrl: string;
}): Promise<void> {
  const { auditId, pdfEmail, score, markdown, targetUrl } = input;
  if (!resend) return;
  const token = (await getShareToken(auditId)) ?? "";
  const reportUrl = `${siteUrl}/r/${token}`;
  const bodyHtml = await markdownToHtml(markdown);
  const html = htmlDocument({
    title: `AEO Audit — ${new URL(targetUrl).hostname}`,
    bodyHtml,
    meta: {
      target: targetUrl,
      score,
      generatedAt: new Date().toISOString(),
    },
  });
  const pdf = await renderPdfFromHtml(html);
  const filename = `crawlproof-${new URL(targetUrl).hostname}-${auditId.slice(0, 8)}.pdf`;
  const sendRes = await resend.emails.send({
    from: process.env.RESEND_FROM ?? "CrawlProof <reports@crawlproof.com>",
    to: pdfEmail,
    subject: `Your CrawlProof audit for ${new URL(targetUrl).hostname} (${score}/100)`,
    html: auditReadyEmailHtml({
      targetUrl,
      score,
      reportUrl,
      pdfAttached: true,
    }),
    attachments: [{ filename, content: pdf.toString("base64") }],
  });
  if (sendRes.error) {
    console.error(
      `[worker] audit ${auditId}: resend rejected send to ${pdfEmail}`,
      sendRes.error,
    );
  } else {
    console.log(
      `[worker] emailed PDF to ${pdfEmail} (id=${sendRes.data?.id ?? "?"})`,
    );
  }
}

async function sendSummaryEmail(input: {
  scanRunId: string;
  projectId: string | null;
  pdfEmail: string;
  targetUrl: string;
  rows: SiblingRow[];
}): Promise<void> {
  const { scanRunId, projectId, pdfEmail, targetUrl, rows } = input;
  if (!resend) return;

  const engines: SummaryEngineRow[] = rows.map((r) => {
    const meta = ENGINES[r.engine as Engine];
    return {
      engine: r.engine,
      label: meta?.label ?? r.engine,
      score: r.score,
      status: r.status,
      passes: r.summary?.pass ?? 0,
      warns: r.summary?.warn ?? 0,
      fails: r.summary?.fail ?? 0,
      reportUrl: `${siteUrl}/audits/${r.id}`,
    };
  });
  const completed = engines.filter((e) => e.status === "complete" && e.score !== null);
  const avgScore =
    completed.length > 0
      ? Math.round(
          completed.reduce((s, e) => s + (e.score ?? 0), 0) / completed.length,
        )
      : null;

  const runUrl = projectId
    ? `${siteUrl}/projects/${projectId}/runs/${scanRunId}`
    : `${siteUrl}/audits/${rows[0].id}`;
  const host = (() => {
    try { return new URL(targetUrl).hostname; } catch { return targetUrl; }
  })();

  // One consolidated PDF: executive summary + each engine's full report.
  const combinedMd = buildSummaryMarkdown({ targetUrl, rows, avgScore });
  const combinedBodyHtml = await markdownToHtml(combinedMd);
  const combinedHtml = htmlDocument({
    title: `AEO Audit — ${host}`,
    bodyHtml: combinedBodyHtml,
    meta: {
      target: targetUrl,
      score: avgScore ?? undefined,
      generatedAt: new Date().toISOString(),
    },
  });
  const pdf = await renderPdfFromHtml(combinedHtml);
  const filename = `crawlproof-${host}-${scanRunId.slice(0, 8)}.pdf`;

  const sendRes = await resend.emails.send({
    from: process.env.RESEND_FROM ?? "CrawlProof <reports@crawlproof.com>",
    to: pdfEmail,
    subject: `Your CrawlProof audit for ${host}${avgScore !== null ? ` (avg ${avgScore}/100)` : ""}`,
    html: scanRunSummaryEmailHtml({ targetUrl, runUrl, engines, avgScore }),
    attachments: [{ filename, content: pdf.toString("base64") }],
  });
  if (sendRes.error) {
    console.error(
      `[worker] scan_run ${scanRunId}: resend rejected summary send to ${pdfEmail}`,
      sendRes.error,
    );
  } else {
    console.log(
      `[worker] scan_run ${scanRunId}: emailed summary to ${pdfEmail} (id=${sendRes.data?.id ?? "?"}, ${engines.length} engines)`,
    );
  }
}

async function getShareToken(auditId: string) {
  const { data } = await supabase
    .from("audits")
    .select("share_token")
    .eq("id", auditId)
    .maybeSingle();
  return data?.share_token ?? null;
}

// HTTP entrypoint: Next.js POSTs to /enqueue when a new audit is created.
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/pdf") {
    if ((req.headers["x-worker-secret"] ?? "") !== sharedSecret) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}") as {
          token?: string;
          markdown?: string;
          title?: string;
          target?: string;
          score?: number;
        };
        let pdf: Buffer;
        if (payload.markdown) {
          const bodyHtml = await markdownToHtml(payload.markdown);
          const html = htmlDocument({
            title: payload.title ?? "CrawlProof audit",
            bodyHtml,
            meta: {
              target: payload.target,
              score: payload.score,
              generatedAt: new Date().toISOString(),
            },
          });
          pdf = await renderPdfFromHtml(html);
        } else if (payload.token) {
          pdf = await renderPdf(`${siteUrl}/r/${payload.token}`);
        } else {
          res.writeHead(400);
          res.end("token or markdown required");
          return;
        }
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(pdf);
      } catch (err) {
        console.error("[worker] /pdf failed", err);
        res.writeHead(500);
        res.end("error");
      }
    });
    return;
  }
  if (req.method !== "POST" || req.url !== "/enqueue") {
    res.writeHead(404);
    res.end();
    return;
  }
  if ((req.headers["x-worker-secret"] ?? "") !== sharedSecret) {
    res.writeHead(401);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    let job: Job;
    try {
      job = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }
    if (!job.auditId) {
      res.writeHead(400);
      res.end("auditId required");
      return;
    }
    // Fire-and-forget; respond immediately.
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted: true }));
    processJob(job).catch((e) => console.error("[worker] unhandled", e));
  });
});

// Polling fallback: in case the HTTP enqueue is missed, sweep every 60s.
async function sweep() {
  const { data, error } = await supabase
    .from("audits")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(5);
  if (error || !data) return;
  for (const row of data) await processJob({ auditId: row.id });
}

setInterval(() => sweep().catch(() => {}), 60_000);

// Bind to loopback by default so the worker isn't reachable from the public
// internet when colocated with the app. Override with WORKER_BIND=0.0.0.0 to
// run as a separate Railway service.
const bindHost = process.env.WORKER_BIND ?? "127.0.0.1";
server.listen(port, bindHost, () => {
  console.log(`[worker] listening on ${bindHost}:${port}`);
  sweep().catch(() => {});
});
