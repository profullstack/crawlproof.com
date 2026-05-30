"use server";

import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { sendAuditReportPdfEmail } from "@/lib/email";
import { recordLead, recordMarketingConsent } from "@/lib/marketing";

type Ok = { ok: true; emailed: boolean };
type Err = { ok: false; error: string };

// Post-report capture. The hero form now collects ONLY a URL; the report
// is shown on-page for free. This action runs when a visitor asks for the
// PDF from /r/<token>: it persists their contact details on the audit row,
// records a lead/consent, then either emails the PDF now (scan complete)
// or lets the worker email it on completion (scan still running — the
// worker reads audits.pdf_email as the fallback recipient).
export async function requestReportPdf(input: {
  token: string;
  email: string;
  phone?: string;
  estimatedMonthlySales?: string;
  marketingOptIn?: boolean;
}): Promise<Ok | Err> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const svc = serviceClient();
  const { data: audit } = await svc
    .from("audits")
    .select(
      "id, target_url, status, score, report_markdown, share_token, pdf_email",
    )
    .eq("share_token", input.token)
    .maybeSingle();
  if (!audit) return { ok: false, error: "Report not found." };

  const salesRaw = input.estimatedMonthlySales?.trim();
  const salesParsed =
    salesRaw && Number.isFinite(Number(salesRaw)) ? Number(salesRaw) : null;

  // Persist contact details on the audit row. The worker reads pdf_email as
  // its fallback recipient, so a still-running scan will email on completion.
  await svc
    .from("audits")
    .update({
      pdf_email: email,
      phone: input.phone?.trim() || null,
      estimated_monthly_sales: salesParsed,
    })
    .eq("id", audit.id);

  // Lead / consent capture. Tick → real opt-in; untick → lead only.
  // Best-effort: failures must not block the PDF send.
  try {
    if (input.marketingOptIn) {
      await recordMarketingConsent({ email, source: "report_pdf" });
    } else {
      await recordLead({ email, source: "report_pdf" });
    }
  } catch (err) {
    console.warn("[requestReportPdf] lead/consent record failed", err);
  }

  // Scan still running: the worker will email the PDF when it finishes.
  if (audit.status !== "complete") {
    return { ok: true, emailed: false };
  }

  if (!audit.report_markdown) {
    return { ok: false, error: "Report isn't ready yet. Try again in a moment." };
  }
  if (!env.workerUrl) {
    return { ok: false, error: "PDF service is not configured." };
  }

  const host = (() => {
    try {
      return new URL(audit.target_url).hostname;
    } catch {
      return audit.target_url;
    }
  })();

  // Render the PDF via the worker, then email it with the report attached.
  const workerRes = await fetch(`${env.workerUrl}/pdf`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": env.workerSecret,
    },
    body: JSON.stringify({
      markdown: audit.report_markdown,
      title: `AEO Audit — ${host}`,
      target: audit.target_url,
      score: audit.score,
    }),
  });
  if (!workerRes.ok) {
    return { ok: false, error: "Could not render the PDF. Please try again." };
  }
  const pdf = Buffer.from(await workerRes.arrayBuffer());

  const reportUrl = `${env.siteUrl.replace(/\/$/, "")}/r/${audit.share_token}`;
  const sent = await sendAuditReportPdfEmail({
    to: email,
    targetUrl: audit.target_url,
    score: audit.score ?? 0,
    reportUrl,
    pdf,
  });
  if (!sent.sent) {
    return { ok: false, error: sent.error ?? "Email failed to send." };
  }
  return { ok: true, emailed: true };
}
