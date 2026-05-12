import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import { runAudit } from "../lib/audit/engine";
import { toMarkdown } from "../lib/audit/markdown";
import { Resend } from "resend";
import { renderPdf, renderPdfFromHtml } from "./pdf";
import { markdownToHtml, htmlDocument } from "../lib/markdown";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sharedSecret = process.env.WORKER_SHARED_SECRET ?? "";
const port = Number(process.env.PORT ?? 8080);
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

type Job = { auditId: string; pdfEmail?: string };

async function processJob(job: Job) {
  const { auditId } = job;
  console.log(`[worker] running audit ${auditId}`);

  const { data: audit, error } = await supabase
    .from("audits")
    .select("id, target_url, owner_id")
    .eq("id", auditId)
    .maybeSingle();
  if (error || !audit) {
    console.error("[worker] audit not found", auditId, error);
    return;
  }

  await supabase
    .from("audits")
    .update({ status: "running" })
    .eq("id", auditId);

  try {
    const result = await runAudit(audit.target_url);

    // Insert findings.
    const rows = result.findings.map((f) => ({
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

    // Render the canonical Markdown report.
    const markdown = toMarkdown({
      targetUrl: audit.target_url,
      score: result.score,
      result,
    });

    // Mark complete.
    await supabase
      .from("audits")
      .update({
        status: "complete",
        score: result.score,
        summary: result.summary,
        report_markdown: markdown,
        completed_at: new Date().toISOString(),
      })
      .eq("id", auditId);

    console.log(`[worker] audit ${auditId} complete, score=${result.score}`);

    // Optionally render PDF + email it.
    if (job.pdfEmail && resend) {
      try {
        const token = (await getShareToken(auditId)) ?? "";
        const reportUrl = `${siteUrl}/r/${token}`;
        // Pandoc-rendered Markdown → standalone HTML doc → Playwright PDF.
        const bodyHtml = await markdownToHtml(markdown);
        const html = htmlDocument({
          title: `CrawlProof — ${new URL(audit.target_url).hostname}`,
          bodyHtml,
        });
        const pdf = await renderPdfFromHtml(html);
        const filename = `crawlproof-${new URL(audit.target_url).hostname}-${auditId.slice(0, 8)}.pdf`;
        await resend.emails.send({
          from: process.env.RESEND_FROM ?? "CrawlProof <reports@crawlproof.com>",
          to: job.pdfEmail,
          subject: `Your AEO audit for ${audit.target_url}`,
          html: `<p>Your audit is ready.</p>
            <p><a href="${reportUrl}">View interactive report</a></p>
            <p>Score: ${result.score}/100</p>`,
          attachments: [{ filename, content: pdf.toString("base64") }],
        });
        console.log(`[worker] emailed PDF to ${job.pdfEmail}`);
      } catch (err) {
        console.error("[worker] PDF/email failed", err);
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
        };
        let pdf: Buffer;
        if (payload.markdown) {
          const bodyHtml = await markdownToHtml(payload.markdown);
          const html = htmlDocument({
            title: payload.title ?? "CrawlProof audit",
            bodyHtml,
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

server.listen(port, () => {
  console.log(`[worker] listening on :${port}`);
  sweep().catch(() => {});
});
