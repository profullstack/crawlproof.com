import { Resend } from "resend";
import { env } from "./env";

let cached: Resend | null = null;
function client() {
  if (cached) return cached;
  if (!env.resendApiKey) return null;
  cached = new Resend(env.resendApiKey);
  return cached;
}

// Shared CrawlProof email shell — mirrors supabase/templates/* so transactional
// mail (audit-ready, receipts) looks the same as auth mail. Score colors hint
// at how the user should feel about the result.
function scoreAccent(score: number): { bg: string; fg: string } {
  if (score >= 80) return { bg: "#6ee7b7", fg: "#042f1a" };
  if (score >= 60) return { bg: "#fcd34d", fg: "#3a2a05" };
  return { bg: "#fca5a5", fg: "#3a0808" };
}

export function auditReadyEmailHtml(input: {
  targetUrl: string;
  score: number;
  reportUrl: string;
  pdfAttached?: boolean;
}): string {
  const host = (() => {
    try { return new URL(input.targetUrl).hostname; } catch { return input.targetUrl; }
  })();
  const accent = scoreAccent(input.score);
  const attachedLine = input.pdfAttached
    ? `<p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#64748b;">A PDF copy of this report is attached to this email.</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your CrawlProof audit for ${host} is ready</title>
</head>
<body style="margin:0;padding:0;background:#0b0d10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e7e9ee;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b0d10;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#12161c;border:1px solid #1f2630;border-radius:14px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding-right:10px;vertical-align:middle;">
                    <div style="width:10px;height:10px;background:#6ee7b7;border-radius:999px;"></div>
                  </td>
                  <td style="vertical-align:middle;color:#e7e9ee;font-weight:700;font-size:16px;">CrawlProof</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0;">
              <h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:800;color:#e7e9ee;">
                Your audit for ${host} is ready
              </h1>
              <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#9aa3b2;">
                We scored <a href="${input.targetUrl}" style="color:#9aa3b2;">${host}</a>
                on how readable it is to AI search and crawlers (AEO).
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background:${accent.bg};color:${accent.fg};font-weight:800;font-size:28px;padding:14px 22px;border-radius:12px;line-height:1;">
                    ${input.score}<span style="font-size:14px;opacity:.7;font-weight:700;"> / 100</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 8px;">
              <a href="${input.reportUrl}"
                 style="display:inline-block;padding:12px 22px;background:#6ee7b7;color:#042f1a;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
                View interactive report →
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px;">
              <p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:#64748b;">
                Or copy this link into your browser:<br>
                <a href="${input.reportUrl}" style="color:#9aa3b2;word-break:break-all;">${input.reportUrl}</a>
              </p>
              ${attachedLine}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 28px;border-top:1px solid #1f2630;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">
                Want to track this site over time? Sign in and add it as a
                project to schedule weekly or monthly re-audits.
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:18px 0 0;font-size:11px;color:#475569;">
          CrawlProof · See your site the way AI crawlers do.<br>
          <a href="${env.siteUrl}" style="color:#64748b;">${env.siteUrl}</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendAuditReadyEmail(input: {
  to: string;
  targetUrl: string;
  score: number;
  reportUrl: string;
}) {
  const c = client();
  if (!c) return;
  await c.emails.send({
    from: env.resendFrom,
    to: input.to,
    subject: `Your AEO audit for ${input.targetUrl} is ready (${input.score}/100)`,
    html: auditReadyEmailHtml(input),
  });
}

export async function sendDigestEmail(input: {
  to: string;
  rows: Array<{ target: string; score: number; url: string }>;
}) {
  const c = client();
  if (!c) return;
  const list = input.rows
    .map(
      (r) =>
        `<li><a href="${r.url}">${r.target}</a> — <strong>${r.score}/100</strong></li>`,
    )
    .join("");
  await c.emails.send({
    from: env.resendFrom,
    to: input.to,
    subject: `Your weekly CrawlProof digest`,
    html: `<p>Your scheduled audits this week:</p><ul>${list}</ul>`,
  });
}

// Plain marketing send (non-transactional). Always appends an unsubscribe
// footer and the List-Unsubscribe headers that mail clients (Gmail, etc.)
// look for to render a native unsubscribe button.
export async function sendMarketingEmail(input: {
  to: string;
  subject: string;
  html: string;
  unsubscribeToken: string;
}): Promise<{ sent: boolean; error?: string }> {
  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };

  const unsubUrl = `${env.siteUrl}/unsubscribe/${input.unsubscribeToken}`;
  const footer = `<hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
    <p style="color:#888;font-size:12px">
      You're receiving this because you opted in on crawlproof.com.
      <a href="${unsubUrl}" style="color:#888">Unsubscribe</a>.
    </p>`;

  const res = await c.emails.send({
    from: env.resendFrom,
    to: input.to,
    subject: input.subject,
    html: `${input.html}${footer}`,
    headers: {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  if (res.error) return { sent: false, error: String(res.error) };
  return { sent: true };
}

export async function sendPurchaseReceiptEmail(input: {
  to: string;
  paymentId: string;
  packLabel: string;
  creditsAdded: number;
  amountCents: number;
  currency: string;
  txHash?: string | null;
  completedAt: string;
  pdf: Buffer;
}): Promise<{ sent: boolean; error?: string }> {
  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };

  const amount = `$${(input.amountCents / 100).toLocaleString(undefined, {
    minimumFractionDigits: input.amountCents % 100 === 0 ? 0 : 2,
  })}`;
  const filename = `crawlproof-receipt-${input.paymentId.slice(0, 12)}.pdf`;
  const txLine = input.txHash
    ? `<p style="color:#666;font-size:12px"><strong>Tx:</strong> <code>${input.txHash}</code></p>`
    : "";

  const res = await c.emails.send({
    from: env.resendFrom,
    to: input.to,
    subject: `Your CrawlProof receipt — ${input.creditsAdded} credit${input.creditsAdded === 1 ? "" : "s"}`,
    html: `<p>Thanks for your purchase!</p>
      <p><strong>${input.packLabel}</strong> — ${input.creditsAdded} credit${input.creditsAdded === 1 ? "" : "s"} added to your account.</p>
      <p><strong>Total paid:</strong> ${amount} ${input.currency}</p>
      <p><strong>Order:</strong> ${input.paymentId}</p>
      ${txLine}
      <p>A PDF copy of this receipt is attached.</p>`,
    attachments: [{ filename, content: input.pdf.toString("base64") }],
  });
  if (res.error) return { sent: false, error: String(res.error) };
  return { sent: true };
}
