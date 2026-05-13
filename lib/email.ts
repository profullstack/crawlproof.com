import { Resend } from "resend";
import { env } from "./env";

let cached: Resend | null = null;
function client() {
  if (cached) return cached;
  if (!env.resendApiKey) return null;
  cached = new Resend(env.resendApiKey);
  return cached;
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
    html: `<p>Your audit is ready.</p>
      <p><strong>Score:</strong> ${input.score}/100</p>
      <p><a href="${input.reportUrl}">View the full report</a></p>`,
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
