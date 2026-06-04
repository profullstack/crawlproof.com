import http from "node:http";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";
import { runAudit } from "../lib/audit/engine";
import { specAudit } from "../lib/audit/spec-engine";
import { claudeAudit } from "../lib/audit/claude-engine";
import { openaiAudit } from "../lib/audit/openai-engine";
import { geminiAudit } from "../lib/audit/gemini-engine";
import { qwenAudit } from "../lib/audit/qwen-engine";
import { kimiAudit } from "../lib/audit/kimi-engine";
import { deepseekAudit } from "../lib/audit/deepseek-engine";
import { perplexityAudit } from "../lib/audit/perplexity-engine";
import { toMarkdown } from "../lib/audit/markdown";
import { Resend } from "resend";
import { renderPdf, renderPdfFromHtml } from "./pdf";
import { markdownToHtml, htmlDocument } from "../lib/markdown";
import { auditReadyEmailHtml, scanRunSummaryEmailHtml, type SummaryEngineRow } from "../lib/email";
import { ENGINES, type Engine } from "../lib/credits";
import { buildScanRunMarkdown } from "../lib/audit/summary-markdown";
import OpenAI from "openai";
import { crawlSitemap } from "../lib/lx/sitemapCrawl";
import { DataForSeoClient } from "../lib/lx/dataforseo";
import { researchKeywords } from "../lib/lx/keywordsResearch";
import Anthropic from "@anthropic-ai/sdk";
import { generateArticle } from "../lib/lx/articleGen";
import { deliverArticle } from "../lib/lx/webhookDeliver";
import { repairStuckLxJobs } from "../lib/lx/repair";
import { processDueSocialFeeds } from "../lib/sp/feedAutopost";
import { processBrowserPost } from "../lib/sp/browserPost";

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
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

async function processLxSitemap(siteId: string) {
  if (!openai) {
    console.error(`[worker] lx sitemap ${siteId}: OPENAI_API_KEY not set`);
    return;
  }
  console.log(`[worker] lx sitemap crawl ${siteId}`);
  try {
    const r = await crawlSitemap(siteId, { supabase, openai });
    console.log(
      `[worker] lx sitemap ${siteId} ok=${r.ok} discovered=${r.discovered} fetched=${r.fetched} embedded=${r.embedded}${r.error ? ` error=${r.error}` : ""}`,
    );
  } catch (err) {
    console.error(`[worker] lx sitemap ${siteId} crashed`, err);
  }
}

async function processLxGuestPost(payload: {
  authorSiteId: string;
  targetSiteId: string;
  topic: string;
  skipDeliver?: boolean;
  requestId?: string;
}) {
  if (!openai) {
    console.error(`[worker] lx guest-post: OPENAI_API_KEY not set`);
    return;
  }
  const { authorSiteId, targetSiteId, topic, skipDeliver, requestId } = payload;
  console.log(
    `[worker] lx guest-post author=${authorSiteId} target=${targetSiteId} topic="${topic}" request=${requestId ?? "-"}`,
  );

  // If the request row was deleted between enqueue and processing
  // (the user clicked "unclick"), bail out. The DELETE policy only
  // allows non-generated rows, so a missing row here means cancel.
  if (requestId) {
    const { data: claimed } = await supabase
      .from("lx_guest_post_request")
      .update({ status: "generating" })
      .eq("id", requestId)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();
    if (!claimed) {
      const { data: current } = await supabase
        .from("lx_guest_post_request")
        .select("status")
        .eq("id", requestId)
        .maybeSingle();
      if (!current) {
        console.log(`[worker] lx guest-post request ${requestId} cancelled — skipping`);
      } else {
        console.log(
          `[worker] lx guest-post request ${requestId} already ${current.status} — skipping`,
        );
      }
      return;
    }
  }

  try {
    const { generateGuestPost } = await import("../lib/lx/guestPostGen");
    const r = await generateGuestPost(
      { authorSiteId, targetSiteId, topic },
      { supabase, openai, anthropic },
    );
    if (!r.ok) {
      console.warn(`[worker] lx guest-post failed: ${r.error}`);
      if (requestId) {
        await supabase
          .from("lx_guest_post_request")
          .update({ status: "failed", error_text: r.error ?? "unknown" })
          .eq("id", requestId);
      }
      return;
    }
    console.log(`[worker] lx guest-post ok article=${r.articleId} slug=${r.slug}`);
    if (requestId && r.articleId) {
      await supabase
        .from("lx_guest_post_request")
        .update({ status: "generated", article_id: r.articleId })
        .eq("id", requestId);
    }
    if (skipDeliver || !r.articleId) return;
    const d = await deliverArticle(r.articleId, { supabase });
    console.log(
      `[worker] lx guest-post deliver ${r.articleId} status=${d.status} code=${d.responseCode ?? "-"} attempts=${d.attempts}${d.error ? ` error=${d.error}` : ""}`,
    );
  } catch (err) {
    console.error(`[worker] lx guest-post crashed`, err);
    if (requestId) {
      await supabase
        .from("lx_guest_post_request")
        .update({
          status: "failed",
          error_text: err instanceof Error ? err.message : String(err),
        })
        .eq("id", requestId);
    }
  }
}

async function processLxGenerate(
  siteId: string,
  opts: { skipDeliver?: boolean; manual?: boolean } = {},
) {
  if (!openai) {
    console.error(`[worker] lx generate ${siteId}: OPENAI_API_KEY not set`);
    return;
  }
  console.log(
    `[worker] lx article generate ${siteId}${opts.skipDeliver ? " (preview)" : ""}`,
  );
  try {
    const r = await generateArticle(
      siteId,
      { supabase, openai, anthropic },
      { manual: !!opts.manual },
    );
    if (r.skipped) {
      console.log(`[worker] lx generate ${siteId} skipped: ${r.skipped}`);
    } else if (r.ok && r.articleId) {
      console.log(`[worker] lx generate ${siteId} ok article=${r.articleId} slug=${r.slug}`);
      if (opts.skipDeliver) {
        // Preview mode: leave the article in status='ready' so the
        // user can review on /autoblog/articles/<id> and click
        // Publish when they're happy.
        return;
      }
      // Chain straight into delivery — the cron's "produce 1 article per
      // due slot" contract means publish should be the same job.
      const d = await deliverArticle(r.articleId, { supabase });
      console.log(
        `[worker] lx deliver ${r.articleId} status=${d.status} code=${d.responseCode ?? "-"} attempts=${d.attempts}${d.error ? ` error=${d.error}` : ""}`,
      );
    } else {
      console.warn(`[worker] lx generate ${siteId} failed: ${r.error}`);
    }
  } catch (err) {
    console.error(`[worker] lx generate ${siteId} crashed`, err);
  }
}

async function processLxKeywords(siteId: string) {
  const login = process.env.DATAFORSEO_LOGIN ?? "";
  const password = process.env.DATAFORSEO_PASSWORD ?? "";
  if (!login || !password) {
    console.error(`[worker] lx keywords ${siteId}: DATAFORSEO_LOGIN/PASSWORD not set`);
    await recordKeywordResearchFailure(
      siteId,
      "DATAFORSEO_LOGIN/PASSWORD not set",
    );
    return;
  }
  console.log(`[worker] lx keywords research ${siteId}`);
  try {
    const dfs = new DataForSeoClient(login, password);
    const r = await researchKeywords(siteId, { supabase, dfs, openai, anthropic });
    if (r.ok) await clearKeywordResearchFailures(siteId);
    else await recordKeywordResearchFailure(siteId, r.error ?? "keyword research failed");
    console.log(
      `[worker] lx keywords ${siteId} ok=${r.ok} inserted=${r.inserted} cost=$${r.apiCost.toFixed(3)}${r.error ? ` error=${r.error}` : ""}`,
    );
  } catch (err) {
    console.error(`[worker] lx keywords ${siteId} crashed`, err);
    await recordKeywordResearchFailure(
      siteId,
      err instanceof Error ? err.message : String(err),
    );
  }
}

function keywordResearchFailureText(error: string): string {
  return `Keyword research failed: ${error}`.slice(0, 500);
}

async function clearKeywordResearchFailures(siteId: string) {
  const { error } = await supabase
    .from("lx_keyword")
    .delete()
    .eq("site_id", siteId)
    .eq("status", "failed")
    .ilike("keyword", "Keyword research failed:%");
  if (error) {
    console.warn(`[worker] clear keyword research failure ${siteId}: ${error.message}`);
  }
}

async function recordKeywordResearchFailure(siteId: string, error: string) {
  await clearKeywordResearchFailures(siteId);
  const { error: insertErr } = await supabase.from("lx_keyword").insert({
    site_id: siteId,
    keyword: keywordResearchFailureText(error),
    scheduled_for: new Date().toISOString().slice(0, 10),
    status: "failed",
    source: "auto",
  });
  if (insertErr) {
    console.warn(`[worker] record keyword research failure ${siteId}: ${insertErr.message}`);
  }
}

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

  // Conditional flip to running — if the user aborted before we picked
  // this job up, aborted_at is non-null and the update returns no rows.
  const { data: claimed } = await supabase
    .from("audits")
    .update({ status: "running" })
    .eq("id", auditId)
    .is("aborted_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) {
    console.log(`[worker] audit ${auditId} was aborted before pickup; skipping`);
    return;
  }

  try {
    // Engine dispatch:
    //   'rule'   — local rule-based crawler (default for anonymous/free)
    //   'claude' — Claude Sonnet 4.6 + web tools (1 credit)
    //   'openai' — OpenAI GPT-5 + web search (1 credit)
    const engine =
      (audit.engine as
        | "rule"
        | "spec"
        | "claude"
        | "openai"
        | "gemini"
        | "qwen"
        | "kimi"
        | "deepseek"
        | "perplexity") ?? "rule";
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
      perplexity: perplexityAudit,
    } as const;

    if (engine === "spec") {
      const r = await specAudit(audit.target_url);
      score = r.score;
      summary = r.summary;
      findings = r.findings;
      markdown = r.markdown;
    } else if (engine in llmEngines) {
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

    // Mark complete — but only if the row hasn't been aborted while we
    // were mid-flight. If aborted_at flipped, this update no-ops and the
    // abort + refund the user already saw stays authoritative.
    const { data: completed } = await supabase
      .from("audits")
      .update({
        status: "complete",
        score,
        summary,
        report_markdown: markdown,
        completed_at: new Date().toISOString(),
      })
      .eq("id", auditId)
      .is("aborted_at", null)
      .select("id")
      .maybeSingle();
    if (!completed) {
      console.log(
        `[worker] audit ${auditId} was aborted mid-flight; skipping complete write + email`,
      );
      return;
    }

    console.log(`[worker] audit ${auditId} complete, score=${score}`);

    // AEO Score time-series: roll up siblings in the scan_run into a
    // single project_scores row. Runs for every completed audit but the
    // UNIQUE(project_id, scan_run_id) constraint ensures exactly one row
    // per scan_run survives.
    if (audit.project_id && audit.scan_run_id) {
      try {
        await recordProjectScoreIfReady({
          projectId: audit.project_id as string,
          scanRunId: audit.scan_run_id as string,
        });
      } catch (err) {
        console.error("[worker] project_scores write failed", err);
      }
    }

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
    // Mark failed only if the row wasn't already aborted by the user.
    // The user-abort path already wrote failed + Aborted by user +
    // refunded; we don't want to clobber that reason or double-refund.
    const { data: updated } = await supabase
      .from("audits")
      .update({
        status: "failed",
        failed_reason: err instanceof Error ? err.message : String(err),
      })
      .eq("id", auditId)
      .is("aborted_at", null)
      .select("engine, owner_id")
      .maybeSingle();
    if (updated) {
      // Natural failure (network, LLM timeout, etc.) — engine didn't
      // produce a result, so refund the credit. ENGINES[engine].cost is
      // 0 for the rule engine, so paid engines net to 0 (paid 1 to
      // queue, refunded 1 on failure).
      const cost = ENGINES[updated.engine as Engine]?.cost ?? 0;
      if (cost > 0 && updated.owner_id) {
        await refundCredits(supabase, updated.owner_id, cost);
      }
    }
  }
}

// Inline refund — the worker can't reach the Next.js rateLimit helper
// directly because the helper imports the server-only serviceClient.
// Same write the in-app refundCredit does (add to profiles.credits_balance).
async function refundCredits(
  sb: typeof supabase,
  ownerId: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  const { data: prof } = await sb
    .from("profiles")
    .select("credits_balance")
    .eq("id", ownerId)
    .maybeSingle();
  if (!prof) return;
  await sb
    .from("profiles")
    .update({ credits_balance: (prof.credits_balance ?? 0) + count })
    .eq("id", ownerId);
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

// Insert one project_scores row per (project, scan_run) once all sibling
// audits in the run reach a terminal state. The aggregate is the mean of
// the completed engines' scores; the components jsonb keeps the per-engine
// breakdown so a chart can drill in. UNIQUE(project_id, scan_run_id) +
// ON CONFLICT DO NOTHING guarantees idempotence under concurrent workers.
async function recordProjectScoreIfReady(input: {
  projectId: string;
  scanRunId: string;
}): Promise<void> {
  const { projectId, scanRunId } = input;
  const { data: siblings } = await supabase
    .from("audits")
    .select("engine, status, score")
    .eq("scan_run_id", scanRunId);
  const rows = (siblings ?? []) as Array<{
    engine: string;
    status: string;
    score: number | null;
  }>;
  if (rows.length === 0) return;
  const allTerminal = rows.every(
    (r) => r.status === "complete" || r.status === "failed",
  );
  if (!allTerminal) return;

  const completed = rows.filter(
    (r) => r.status === "complete" && typeof r.score === "number",
  );
  // No engine produced a usable score (every sibling failed). Skip — a zero
  // here would be misleading on the trend chart.
  if (completed.length === 0) return;

  const components: Record<string, number> = {};
  for (const r of completed) {
    components[r.engine] = r.score as number;
  }
  const overall = Math.round(
    completed.reduce((sum, r) => sum + (r.score as number), 0) / completed.length,
  );

  const { error } = await supabase.from("project_scores").insert({
    project_id: projectId,
    scan_run_id: scanRunId,
    score: overall,
    components,
  });
  // 23505 = unique_violation; another worker beat us to it. Not an error.
  if (error && (error as { code?: string }).code !== "23505") {
    console.error("[worker] project_scores insert", error);
  }
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
  const combinedMd = buildScanRunMarkdown({ targetUrl, rows });
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
  if (req.method === "POST" && req.url === "/lx/sitemap-crawl") {
    if ((req.headers["x-worker-secret"] ?? "") !== sharedSecret) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      let payload: { siteId?: string };
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      if (!payload.siteId) {
        res.writeHead(400);
        res.end("siteId required");
        return;
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
      processLxSitemap(payload.siteId).catch((e) =>
        console.error("[worker] lx sitemap unhandled", e),
      );
    });
    return;
  }
  if (req.method === "POST" && req.url === "/lx/article-deliver") {
    if ((req.headers["x-worker-secret"] ?? "") !== sharedSecret) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      let payload: { articleId?: string };
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      if (!payload.articleId) {
        res.writeHead(400);
        res.end("articleId required");
        return;
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
      deliverArticle(payload.articleId, { supabase })
        .then((d) =>
          console.log(
            `[worker] lx deliver ${payload.articleId} status=${d.status} code=${d.responseCode ?? "-"} attempts=${d.attempts}${d.error ? ` error=${d.error}` : ""}`,
          ),
        )
        .catch((e) => console.error("[worker] lx deliver unhandled", e));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/lx/article-generate") {
    if ((req.headers["x-worker-secret"] ?? "") !== sharedSecret) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      let payload: { siteId?: string; preview?: boolean; manual?: boolean };
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      if (!payload.siteId) {
        res.writeHead(400);
        res.end("siteId required");
        return;
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
      processLxGenerate(payload.siteId, {
        skipDeliver: !!payload.preview,
        manual: !!payload.manual,
      }).catch((e) => console.error("[worker] lx generate unhandled", e));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/lx/guest-post-generate") {
    if ((req.headers["x-worker-secret"] ?? "") !== sharedSecret) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      let payload: {
        authorSiteId?: string;
        targetSiteId?: string;
        topic?: string;
        preview?: boolean;
        requestId?: string;
      };
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      if (!payload.authorSiteId || !payload.targetSiteId || !payload.topic) {
        res.writeHead(400);
        res.end("authorSiteId, targetSiteId, topic required");
        return;
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
      processLxGuestPost({
        authorSiteId: payload.authorSiteId,
        targetSiteId: payload.targetSiteId,
        topic: payload.topic,
        skipDeliver: !!payload.preview,
        requestId: payload.requestId,
      }).catch((e) => console.error("[worker] lx guest-post unhandled", e));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/lx/keywords-research") {
    if ((req.headers["x-worker-secret"] ?? "") !== sharedSecret) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      let payload: { siteId?: string };
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      if (!payload.siteId) {
        res.writeHead(400);
        res.end("siteId required");
        return;
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
      processLxKeywords(payload.siteId).catch((e) =>
        console.error("[worker] lx keywords unhandled", e),
      );
    });
    return;
  }
  if (req.method === "POST" && req.url === "/sp/browser-post") {
    if ((req.headers["x-worker-secret"] ?? "") !== sharedSecret) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      let payload: { postId?: string };
      try { payload = JSON.parse(body || "{}"); } catch {
        res.writeHead(400); res.end("bad json"); return;
      }
      if (!payload.postId) {
        res.writeHead(400); res.end("postId required"); return;
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
      processBrowserPost({ postId: payload.postId, supabase, openai }).catch((e) =>
        console.error("[worker] browser post unhandled", e),
      );
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

// Recover audits orphaned by a worker crash or by an upstream LLM that
// opened a connection then never delivered. Worst case the new
// 90s × 3-attempt budget caps a healthy in-flight call around 4.5
// minutes; anything still in `running` past 7 minutes is stuck.
// Flip to failed + refund so the user sees a result and can retry.
const AUDIT_STUCK_AFTER_MS = 7 * 60 * 1000;
async function auditStuckSweep() {
  const cutoff = new Date(Date.now() - AUDIT_STUCK_AFTER_MS).toISOString();
  const { data: stuck, error: stuckErr } = await supabase
    .from("audits")
    .select("id, engine, owner_id")
    .eq("status", "running")
    .is("aborted_at", null)
    .lt("created_at", cutoff);
  if (stuckErr) {
    console.warn("[worker] audit stuck sweep", stuckErr.message);
    return;
  }
  if (!stuck || stuck.length === 0) return;

  const now = new Date().toISOString();
  for (const row of stuck) {
    const { data: flipped } = await supabase
      .from("audits")
      .update({
        status: "failed",
        failed_reason: "Engine timed out (no response in 7 minutes)",
        completed_at: now,
      })
      .eq("id", row.id)
      .eq("status", "running")
      .is("aborted_at", null)
      .select("id")
      .maybeSingle();
    if (!flipped) continue;
    const cost = ENGINES[row.engine as Engine]?.cost ?? 0;
    if (cost > 0 && row.owner_id) {
      await refundCredits(supabase, row.owner_id, cost);
    }
    console.log(`[worker] audit ${row.id} stuck — flipped to failed + refunded`);
  }
}

async function lxSweep() {
  const repaired = await repairStuckLxJobs(supabase);
  const totalRecovered =
    repaired.publishingArticles +
    repaired.generatingKeywordsWithArticle +
    repaired.generatingKeywordsRequeued +
    repaired.generatingGuestRequests;
  if (totalRecovered > 0) {
    console.log("[worker] lx sweep recovered", repaired);
  }

  // Guest-post requests are persisted before the worker is notified. If
  // that fire-and-forget notify fails, the row stays queued forever unless
  // the worker polls it. This sweep is the durable queue fallback.
  const { data: queuedGuestRequests, error: guestErr } = await supabase
    .from("lx_guest_post_request")
    .select("id, author_site_id, target_site_id, topic")
    .eq("status", "queued")
    .order("updated_at", { ascending: true })
    .limit(10);
  if (guestErr) {
    console.warn("[worker] lx sweep guest requests", guestErr.message);
    return;
  }
  for (const req of queuedGuestRequests ?? []) {
    await processLxGuestPost({
      authorSiteId: req.author_site_id as string,
      targetSiteId: req.target_site_id as string,
      topic: req.topic as string,
      requestId: req.id as string,
    });
  }
}

async function browserPostSweep() {
  const { data: posts, error } = await supabase
    .from("sp_post")
    .select("id")
    .eq("status", "queued_browser")
    .order("created_at", { ascending: true })
    .limit(3);
  if (error || !posts) return;
  for (const post of posts) {
    await processBrowserPost({ postId: post.id, supabase, openai }).catch((e) =>
      console.error("[worker] browser post unhandled", e),
    );
  }
}

async function socialFeedSweep() {
  const results = await processDueSocialFeeds(supabase, {
    limit: 10,
    clients: { anthropic, openai },
  });
  for (const result of results) {
    if (!result.ok) {
      console.warn(`[worker] social feed ${result.configId ?? "-"} failed: ${result.error}`);
      continue;
    }
    if ((result.newItems ?? 0) > 0 || (result.posted ?? 0) > 0) {
      console.log(
        `[worker] social feed ${result.configId} checked=${result.checked ?? 0} new=${result.newItems ?? 0} posted=${result.posted ?? 0} seeded=${result.seeded ?? 0}`,
      );
    }
  }
}

setInterval(() => sweep().catch(() => {}), 60_000);
setInterval(() => browserPostSweep().catch((e) => console.error("[worker] browser post sweep", e)), 60_000);
setInterval(() => lxSweep().catch((e) => console.error("[worker] lx sweep", e)), 60_000);
setInterval(
  () => socialFeedSweep().catch((e) => console.error("[worker] social feed sweep", e)),
  60_000,
);
setInterval(
  () => auditStuckSweep().catch((e) => console.error("[worker] audit stuck sweep", e)),
  60_000,
);

// Bind to loopback by default so the worker isn't reachable from the public
// internet when colocated with the app. Override with WORKER_BIND=0.0.0.0 to
// run as a separate Railway service.
const bindHost = process.env.WORKER_BIND ?? "127.0.0.1";
server.listen(port, bindHost, () => {
  console.log(`[worker] listening on ${bindHost}:${port}`);
  sweep().catch(() => {});
  socialFeedSweep().catch((e) => console.error("[worker] social feed sweep", e));
});
