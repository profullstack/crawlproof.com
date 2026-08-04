import { createEmailer, type Emailer } from "@profullstack/stack/email";
import { env } from "./env";
import type { SenderMailbox } from "./outreach/senderMailbox";

let cached: Emailer | null = null;
function client() {
  if (cached) return cached;
  if (!env.resendApiKey) return null;
  cached = createEmailer({
    resendApiKey: env.resendApiKey,
    defaultFrom: env.resendFrom,
  });
  return cached;
}

// Shared CrawlProof email shell — mirrors supabase/templates/* so transactional
// mail (audit-ready, receipts) looks the same as auth mail.
function scoreAccent(score: number): { bg: string; fg: string } {
  if (score >= 80) return { bg: "#6ee7b7", fg: "#042f1a" };
  if (score >= 60) return { bg: "#fcd34d", fg: "#3a2a05" };
  return { bg: "#fca5a5", fg: "#3a0808" };
}

function emailShell(input: {
  title: string;
  innerHtml: string;
  footerNote?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${input.title}</title>
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
          ${input.innerHtml}
          ${
            input.footerNote
              ? `<tr>
            <td style="padding:16px 32px 28px;border-top:1px solid #1f2630;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">${input.footerNote}</p>
            </td>
          </tr>`
              : ""
          }
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

export function auditReadyEmailHtml(input: {
  targetUrl: string;
  score: number;
  reportUrl: string;
  pdfAttached?: boolean;
}): string {
  const host = (() => {
    try {
      return new URL(input.targetUrl).hostname;
    } catch {
      return input.targetUrl;
    }
  })();
  const accent = scoreAccent(input.score);
  const attachedLine = input.pdfAttached
    ? `<p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#64748b;">A PDF copy of this report is attached to this email.</p>`
    : "";
  const innerHtml = `<tr>
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
          </tr>`;
  return emailShell({
    title: `Your CrawlProof audit for ${host} is ready`,
    innerHtml,
    footerNote:
      "Want to track this site over time? Sign in and add it as a project to schedule weekly or monthly re-audits.",
  });
}

export type SummaryEngineRow = {
  engine: string;
  label: string;
  score: number | null;
  status: string;
  passes: number;
  warns: number;
  fails: number;
  reportUrl: string;
};

export function scanRunSummaryEmailHtml(input: {
  targetUrl: string;
  runUrl: string;
  engines: SummaryEngineRow[];
  avgScore: number | null;
}): string {
  const host = (() => {
    try {
      return new URL(input.targetUrl).hostname;
    } catch {
      return input.targetUrl;
    }
  })();
  const accent =
    input.avgScore !== null ? scoreAccent(input.avgScore) : scoreAccent(0);
  const rows = input.engines
    .map((e) => {
      const scoreCell =
        e.status === "complete" && e.score !== null
          ? `<span style="font-weight:700;color:#e7e9ee;">${e.score}</span><span style="color:#64748b;"> / 100</span>`
          : `<span style="color:#fca5a5;">${e.status}</span>`;
      const counts =
        e.status === "complete"
          ? `<span style="color:#6ee7b7;">${e.passes}</span> · <span style="color:#fcd34d;">${e.warns}</span> · <span style="color:#fca5a5;">${e.fails}</span>`
          : "—";
      return `<tr>
        <td style="padding:10px 0;border-top:1px solid #1f2630;">
          <a href="${e.reportUrl}" style="color:#e7e9ee;text-decoration:none;font-weight:600;font-size:14px;">${e.label}</a>
        </td>
        <td style="padding:10px 0;border-top:1px solid #1f2630;text-align:right;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;">${scoreCell}</td>
        <td style="padding:10px 0;border-top:1px solid #1f2630;text-align:right;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;color:#9aa3b2;">${counts}</td>
      </tr>`;
    })
    .join("");

  const avgBlock =
    input.avgScore !== null
      ? `<tr>
            <td style="padding:20px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background:${accent.bg};color:${accent.fg};font-weight:800;font-size:28px;padding:14px 22px;border-radius:12px;line-height:1;">
                    ${input.avgScore}<span style="font-size:14px;opacity:.7;font-weight:700;"> / 100</span>
                  </td>
                  <td style="padding-left:14px;color:#9aa3b2;font-size:13px;">
                    average across ${input.engines.length} engine${input.engines.length === 1 ? "" : "s"}
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
      : "";

  const innerHtml = `<tr>
            <td style="padding:24px 32px 0;">
              <h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:800;color:#e7e9ee;">
                Your multi-engine audit for ${host} is ready
              </h1>
              <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#9aa3b2;">
                We scored <a href="${input.targetUrl}" style="color:#9aa3b2;">${host}</a>
                with ${input.engines.length} engine${input.engines.length === 1 ? "" : "s"}.
              </p>
            </td>
          </tr>
          ${avgBlock}
          <tr>
            <td style="padding:18px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <thead>
                  <tr>
                    <th align="left" style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#64748b;padding:6px 0;">Engine</th>
                    <th align="right" style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#64748b;padding:6px 0;">Score</th>
                    <th align="right" style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#64748b;padding:6px 0;">Pass · Warn · Fail</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 24px;">
              <a href="${input.runUrl}"
                 style="display:inline-block;padding:12px 22px;background:#6ee7b7;color:#042f1a;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
                Open scan results →
              </a>
              <p style="margin:12px 0 0;font-size:12px;line-height:1.6;color:#64748b;">
                Or copy this link:<br>
                <a href="${input.runUrl}" style="color:#9aa3b2;word-break:break-all;">${input.runUrl}</a>
              </p>
            </td>
          </tr>`;
  return emailShell({
    title: `Your CrawlProof audit for ${host} is ready`,
    innerHtml,
    footerNote: "Each engine has its own full report behind the link above.",
  });
}

export function purchaseReceiptEmailHtml(input: {
  packLabel: string;
  creditsAdded: number;
  amountFormatted: string;
  currency: string;
  paymentId: string;
  txHash?: string | null;
}): string {
  const txRow = input.txHash
    ? `<tr>
        <td style="padding:6px 0;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.1em;">Tx</td>
        <td style="padding:6px 0;color:#e7e9ee;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;word-break:break-all;">${input.txHash}</td>
      </tr>`
    : "";
  const innerHtml = `<tr>
            <td style="padding:24px 32px 0;">
              <h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:800;color:#e7e9ee;">
                Thanks for your purchase
              </h1>
              <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#9aa3b2;">
                <strong style="color:#6ee7b7;">${input.creditsAdded} credit${input.creditsAdded === 1 ? "" : "s"}</strong>
                added to your CrawlProof account.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0b0d10;border:1px solid #1f2630;border-radius:10px;padding:14px 18px;">
                <tr>
                  <td style="padding:6px 0;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.1em;">Pack</td>
                  <td style="padding:6px 0;color:#e7e9ee;font-size:14px;font-weight:600;text-align:right;">${input.packLabel}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.1em;">Credits</td>
                  <td style="padding:6px 0;color:#e7e9ee;font-size:14px;font-weight:600;text-align:right;">${input.creditsAdded}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.1em;">Total</td>
                  <td style="padding:6px 0;color:#e7e9ee;font-size:14px;font-weight:600;text-align:right;">${input.amountFormatted} ${input.currency}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.1em;">Order</td>
                  <td style="padding:6px 0;color:#e7e9ee;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;text-align:right;word-break:break-all;">${input.paymentId}</td>
                </tr>
                ${txRow}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 8px;">
              <a href="${env.siteUrl}/settings/billing"
                 style="display:inline-block;padding:12px 22px;background:#6ee7b7;color:#042f1a;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
                View billing →
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px;">
              <p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:#64748b;">
                A PDF copy of this receipt is attached for your records.
              </p>
            </td>
          </tr>`;
  return emailShell({
    title: `Your CrawlProof receipt`,
    innerHtml,
    footerNote: "Credits never expire and can be used on any scan engine.",
  });
}

export async function sendAuditReadyEmail(input: {
  to: string;
  targetUrl: string;
  score: number;
  reportUrl: string;
}) {
  const c = client();
  if (!c) return;
  await c.send({
    from: env.resendFrom,
    to: input.to,
    subject: `Your AEO audit for ${input.targetUrl} is ready (${input.score}/100)`,
    html: auditReadyEmailHtml(input),
  });
}

// Email a completed report's PDF on demand — used by the post-report
// "email me the PDF" capture on /r/<token>. Mirrors the worker's
// sendPerEngineEmail (same template + attachment) but runs in-app so a
// visitor can request the PDF after the scan has already finished.
export async function sendAuditReportPdfEmail(input: {
  to: string;
  targetUrl: string;
  score: number;
  reportUrl: string;
  pdf: Buffer;
}): Promise<{ sent: boolean; error?: string }> {
  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };
  const host = (() => {
    try {
      return new URL(input.targetUrl).hostname;
    } catch {
      return input.targetUrl;
    }
  })();
  const res = await c.send({
    from: env.resendFrom,
    to: input.to,
    subject: `Your CrawlProof audit for ${host} (${input.score}/100)`,
    html: auditReadyEmailHtml({
      targetUrl: input.targetUrl,
      score: input.score,
      reportUrl: input.reportUrl,
      pdfAttached: true,
    }),
    attachments: [
      {
        filename: `crawlproof-${host}.pdf`,
        content: input.pdf.toString("base64"),
      },
    ],
  });
  if (!res.sent) return { sent: false, error: res.error };
  return { sent: true };
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
  await c.send({
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

  const res = await c.send({
    from: env.resendFrom,
    to: input.to,
    subject: input.subject,
    html: `${input.html}${footer}`,
    headers: {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  if (!res.sent) return { sent: false, error: res.error };
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

  const res = await c.send({
    from: env.resendFrom,
    to: input.to,
    subject: `Your CrawlProof receipt — ${input.creditsAdded} credit${input.creditsAdded === 1 ? "" : "s"}`,
    html: purchaseReceiptEmailHtml({
      packLabel: input.packLabel,
      creditsAdded: input.creditsAdded,
      amountFormatted: amount,
      currency: input.currency,
      paymentId: input.paymentId,
      txHash: input.txHash,
    }),
    attachments: [{ filename, content: input.pdf.toString("base64") }],
  });
  if (!res.sent) return { sent: false, error: res.error };
  return { sent: true };
}

export function premiumDeckEmailHtml(input: { deckUrl: string }): string {
  const innerHtml = `<tr>
            <td style="padding:24px 32px 0;">
              <h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:800;color:#e7e9ee;">
                Your CrawlProof premium deck is attached
              </h1>
              <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#9aa3b2;">
                The PDF deck walks through the premium AEO workflow: multi-engine scans,
                visibility gaps, reporting, and where Autoblog fits into the growth loop.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 8px;">
              <a href="${input.deckUrl}"
                 style="display:inline-block;padding:12px 22px;background:#6ee7b7;color:#042f1a;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
                Open deck →
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px;">
              <p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:#64748b;">
                A PDF copy is attached. Backup link:<br>
                <a href="${input.deckUrl}" style="color:#9aa3b2;word-break:break-all;">${input.deckUrl}</a>
              </p>
            </td>
          </tr>`;
  return emailShell({
    title: "Your CrawlProof premium deck",
    innerHtml,
    footerNote:
      "This is a transactional email sent because you requested the premium deck.",
  });
}

export async function sendPremiumDeckEmail(input: {
  to: string;
  pdf: Buffer;
}): Promise<{ sent: boolean; error?: string }> {
  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };

  const deckUrl = `${env.siteUrl}/pdfs/CrawlProof_Premium_Deck.pdf`;
  const res = await c.send({
    from: env.resendFrom,
    to: input.to,
    subject: "Your CrawlProof premium deck",
    html: premiumDeckEmailHtml({ deckUrl }),
    attachments: [
      {
        filename: "CrawlProof_Premium_Deck.pdf",
        content: input.pdf.toString("base64"),
      },
    ],
  });
  if (!res.sent) return { sent: false, error: res.error };
  return { sent: true };
}

// Internal lead notification — sent to the sales inbox when a visitor fills
// out the /hire contact form. Plain HTML, no shell branding (this lands in
// our inbox, not the customer's).
export async function sendHireInquiryEmail(input: {
  name: string;
  email: string;
  phone: string;
  website: string;
  monthlyRevenue?: string;
  location?: string;
  message?: string;
}): Promise<{ sent: boolean; error?: string }> {
  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const row = (label: string, value?: string) =>
    value
      ? `<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top;">${label}</td><td style="padding:6px 0;"><strong>${esc(value)}</strong></td></tr>`
      : "";
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
    <h2 style="margin:0 0 12px">New AEO-fix inquiry</h2>
    <table cellpadding="0" cellspacing="0" border="0">
      ${row("Name", input.name)}
      ${row("Email", input.email)}
      ${row("Phone", input.phone)}
      ${row("Website", input.website)}
      ${row("Monthly revenue", input.monthlyRevenue)}
      ${row("Location", input.location)}
    </table>
    ${input.message ? `<p style="margin-top:16px"><strong>Message</strong><br/><pre style="white-space:pre-wrap;font-family:inherit;background:#f6f8fa;padding:12px;border-radius:6px">${esc(input.message)}</pre></p>` : ""}
  </body></html>`;

  const res = await c.send({
    from: env.resendFrom,
    to: "hello@crawlproof.com",
    replyTo: input.email,
    subject: `Hire-us inquiry: ${input.name} (${input.website})`,
    html,
  });
  if (!res.sent) return { sent: false, error: res.error };
  return { sent: true };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendProjectInviteEmail(input: {
  to: string;
  invitedBy: string;
  projectName: string;
  acceptUrl: string;
}): Promise<{ sent: boolean; error?: string }> {
  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };

  const innerHtml = `
    <tr>
      <td style="padding:28px 32px 8px;">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#e7e9ee;">You've been invited</h1>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#94a3b8;">
          <strong style="color:#e7e9ee;">${escapeHtml(input.invitedBy)}</strong> invited you to join the
          <strong style="color:#e7e9ee;">${escapeHtml(input.projectName)}</strong> project on CrawlProof.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px 32px;">
        <a href="${input.acceptUrl}"
           style="display:inline-block;background:#6ee7b7;color:#042f1a;font-weight:700;font-size:15px;
                  text-decoration:none;padding:12px 28px;border-radius:8px;">
          Accept Invitation
        </a>
        <p style="margin:20px 0 0;font-size:13px;color:#64748b;">
          This link expires in 7 days. If you don't have a CrawlProof account you'll be prompted to create one.
        </p>
      </td>
    </tr>
  `;

  const html = emailShell({
    title: `Invitation to join ${input.projectName} on CrawlProof`,
    innerHtml,
    footerNote:
      "If you weren't expecting this invitation, you can safely ignore this email.",
  });

  const res = await c.send({
    from: env.resendFrom,
    to: input.to,
    subject: `${escapeHtml(input.invitedBy)} invited you to ${escapeHtml(input.projectName)} on CrawlProof`,
    html,
  });
  if (!res.sent) return { sent: false, error: res.error };
  return { sent: true };
}

export async function sendOrgInviteEmail(input: {
  to: string;
  invitedBy: string;
  orgName: string;
  acceptUrl: string;
}): Promise<{ sent: boolean; error?: string }> {
  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };

  const innerHtml = `
    <tr>
      <td style="padding:28px 32px 8px;">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#e7e9ee;">You've been invited</h1>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#94a3b8;">
          <strong style="color:#e7e9ee;">${escapeHtml(input.invitedBy)}</strong> invited you to join the
          <strong style="color:#e7e9ee;">${escapeHtml(input.orgName)}</strong> organization on CrawlProof.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px 32px;">
        <a href="${input.acceptUrl}"
           style="display:inline-block;background:#6ee7b7;color:#042f1a;font-weight:700;font-size:15px;
                  text-decoration:none;padding:12px 28px;border-radius:8px;">
          Accept Invitation
        </a>
        <p style="margin:20px 0 0;font-size:13px;color:#64748b;">
          This link expires in 7 days. If you don't have a CrawlProof account you'll be prompted to create one.
        </p>
      </td>
    </tr>
  `;

  const html = emailShell({
    title: `Invitation to join ${input.orgName} on CrawlProof`,
    innerHtml,
    footerNote:
      "If you weren't expecting this invitation, you can safely ignore this email.",
  });

  const res = await c.send({
    from: env.resendFrom,
    to: input.to,
    subject: `${escapeHtml(input.invitedBy)} invited you to ${escapeHtml(input.orgName)} on CrawlProof`,
    html,
  });
  if (!res.sent) return { sent: false, error: res.error };
  return { sent: true };
}

// ============================================================
// "Watch this URL" — M2 of docs/lead-engine-prd.md.
// ============================================================

export function watchConfirmEmailHtml(input: {
  host: string;
  label: string;
  cadence: string;
  confirmUrl: string;
}): string {
  const innerHtml = `<tr>
            <td style="padding:24px 32px 0;">
              <h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:800;color:#e7e9ee;">
                Confirm you want ${escapeHtml(input.host)} watched
              </h1>
              <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#9aa3b2;">
                Someone asked us to re-scan
                <strong style="color:#e7e9ee;">${escapeHtml(input.host)}</strong>
                ${escapeHtml(input.cadence)} and email this address when its
                ${escapeHtml(input.label)} changes. Click below to start — we won't
                send anything until you do.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 8px;">
              <a href="${input.confirmUrl}"
                 style="display:inline-block;padding:12px 22px;background:#6ee7b7;color:#042f1a;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
                Start watching ${escapeHtml(input.host)} →
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px;">
              <p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:#64748b;">
                Or copy this link into your browser:<br>
                <a href="${input.confirmUrl}" style="color:#9aa3b2;word-break:break-all;">${input.confirmUrl}</a>
              </p>
            </td>
          </tr>`;
  return emailShell({
    title: `Confirm watching ${input.host}`,
    innerHtml,
    footerNote:
      "If you didn't request this, ignore this email and nothing further will be sent. " +
      "We only start watching a site after this link is clicked.",
  });
}

export async function sendWatchConfirmEmail(input: {
  to: string;
  host: string;
  label: string;
  cadence: string;
  confirmUrl: string;
}): Promise<{ sent: boolean; error?: string }> {
  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };
  const res = await c.send({
    from: env.resendFrom,
    to: input.to,
    subject: `Confirm: watch ${input.host} for changes`,
    html: watchConfirmEmailHtml(input),
  });
  if (!res.sent) return { sent: false, error: res.error };
  return { sent: true };
}

export function watchChangeEmailHtml(input: {
  host: string;
  label: string;
  score: number;
  previousScore: number | null;
  /** Already accounts for the inverted slop dial. */
  improved: boolean;
  first: boolean;
  scaleHint: string;
  reportUrl: string;
  stopUrl: string;
  cadence: string;
}): string {
  const accent = input.first
    ? { bg: "#6ee7b7", fg: "#042f1a" }
    : input.improved
      ? { bg: "#6ee7b7", fg: "#042f1a" }
      : { bg: "#fca5a5", fg: "#3a0808" };

  const movement = input.first
    ? `This is the baseline we'll compare future scans against.`
    : `${input.improved ? "Better" : "Worse"} than last time — it was
       <strong style="color:#e7e9ee;">${input.previousScore}</strong>.`;

  const innerHtml = `<tr>
            <td style="padding:24px 32px 0;">
              <h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:800;color:#e7e9ee;">
                ${input.first ? `Now watching ${escapeHtml(input.host)}` : `${escapeHtml(input.host)} ${input.improved ? "improved" : "got worse"}`}
              </h1>
              <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#9aa3b2;">
                ${movement}
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
                  <td style="padding-left:14px;color:#9aa3b2;font-size:13px;">
                    ${escapeHtml(input.label)}<br>
                    <span style="color:#64748b;font-size:12px;">${escapeHtml(input.scaleHint)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 8px;">
              <a href="${input.reportUrl}"
                 style="display:inline-block;padding:12px 22px;background:#6ee7b7;color:#042f1a;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
                See what changed →
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px;">
              <p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:#64748b;">
                Full report:<br>
                <a href="${input.reportUrl}" style="color:#9aa3b2;word-break:break-all;">${input.reportUrl}</a>
              </p>
            </td>
          </tr>`;
  return emailShell({
    title: `${input.host} — ${input.label} ${input.score}/100`,
    innerHtml,
    footerNote:
      `You asked us to re-scan ${escapeHtml(input.host)} ${escapeHtml(input.cadence)}. ` +
      `<a href="${input.stopUrl}" style="color:#64748b;">Stop watching this site</a>.`,
  });
}

export async function sendWatchChangeEmail(input: {
  to: string;
  subject: string;
  host: string;
  label: string;
  score: number;
  previousScore: number | null;
  improved: boolean;
  first: boolean;
  scaleHint: string;
  reportUrl: string;
  stopUrl: string;
  cadence: string;
}): Promise<{ sent: boolean; error?: string }> {
  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };
  const res = await c.send({
    from: env.resendFrom,
    to: input.to,
    subject: input.subject,
    html: watchChangeEmailHtml(input),
    // Recurring mail, so mail clients get a native one-click stop button.
    headers: {
      "List-Unsubscribe": `<${input.stopUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  if (!res.sent) return { sent: false, error: res.error };
  return { sent: true };
}

// ============================================================
// Lead re-engagement campaign — personalised from the recipient's OWN scan.
//
// Deliberately not a newsletter blast. Everyone who gets this asked us for a
// PDF of a specific report, so the email is about that report: their host,
// their score, their worst findings. That converts better than a generic
// pitch, and it keeps the message tied to the thing they actually requested.
// ============================================================

export function leadCampaignEmailHtml(input: {
  host: string;
  scoreLabel: string;
  score: number | null;
  scaleHint: string;
  topIssues: string[];
  reportUrl: string;
  hireUrl: string;
  isCustomer: boolean;
  /** Already scoring well — don't pitch a rescue at them. */
  strong?: boolean;
}): string {
  const issues = input.topIssues.length
    ? `<ul style="margin:14px 0 0;padding-left:18px;color:#9aa3b2;font-size:14px;line-height:1.8;">
         ${input.topIssues.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}
       </ul>`
    : "";

  const scoreBlock =
    input.score !== null
      ? `<tr>
            <td style="padding:20px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background:#12161c;border:1px solid #1f2630;color:#e7e9ee;font-weight:800;font-size:26px;padding:14px 22px;border-radius:12px;line-height:1;">
                    ${input.score}<span style="font-size:13px;opacity:.6;font-weight:700;"> / 100</span>
                  </td>
                  <td style="padding-left:14px;color:#9aa3b2;font-size:13px;">
                    ${escapeHtml(input.scoreLabel)}<br>
                    <span style="color:#64748b;font-size:12px;">${escapeHtml(input.scaleHint)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
      : "";

  const innerHtml = `<tr>
            <td style="padding:24px 32px 0;">
              <h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:800;color:#e7e9ee;">
                About your ${escapeHtml(input.host)} scan
              </h1>
              <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#9aa3b2;">
                You ran a CrawlProof report on
                <strong style="color:#e7e9ee;">${escapeHtml(input.host)}</strong>
                and asked us to email you the PDF. Here's where it landed${input.isCustomer ? "" : " — and an offer, if you'd rather not fix it yourself"}.
              </p>
            </td>
          </tr>
          ${scoreBlock}
          <tr>
            <td style="padding:18px 32px 0;">
              ${input.topIssues.length ? `<p style="margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#64748b;">Biggest items on that report</p>` : ""}
              ${issues}
            </td>
          </tr>
          <tr>
            <td style="padding:22px 32px 0;">
              <p style="margin:0;font-size:14px;line-height:1.6;color:#9aa3b2;">
                ${
                  input.strong
                    ? `That's a strong result — most sites we scan don't get there. If you want the remaining gaps closed properly, we do that work directly.`
                    : `We also fix these directly. Tell us about the site and we'll come back with what it takes to move that number — no obligation.`
                }
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 8px;">
              <a href="${input.hireUrl}"
                 style="display:inline-block;padding:12px 22px;background:#6ee7b7;color:#042f1a;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
                Get a fix quote →
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 24px;">
              <p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:#64748b;">
                Your report is still live:<br>
                <a href="${input.reportUrl}" style="color:#9aa3b2;word-break:break-all;">${input.reportUrl}</a>
              </p>
            </td>
          </tr>`;

  return emailShell({
    title: `Your CrawlProof scan of ${input.host}`,
    innerHtml,
  });
}

// ---------------------------------------------------------------- cold outreach

/**
 * A cold pitch to someone who never gave us their address.
 *
 * Deliberately NOT sendMarketingEmail: that footer says "you opted in on
 * crawlproof.com", which is false here, and its unsubscribe token belongs to
 * marketing_contacts — putting a cold prospect on that list to give them an
 * unsubscribe link would also enrol them in the newsletter blast.
 *
 * The footer states plainly why they are hearing from us, offers one-click
 * opt-out for the address and for the whole domain, and carries the postal
 * address CAN-SPAM §7704(a)(5) requires. Sending refuses without it.
 */
export function coldOutreachEmailHtml(input: {
  host: string;
  bodyText: string;
  reportUrl: string | null;
  unsubscribeUrl: string;
  postalAddress: string;
  /**
   * Open-tracking pixel markup, when this send is being tracked. Absent for
   * dry runs, which are never delivered and so can never be opened.
   */
  trackingPixel?: string | null;
}): string {
  const paragraphs = input.bodyText
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#c7cdd8;">${escapeHtml(
          p,
        ).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");

  const reportBlock = input.reportUrl
    ? `<tr>
            <td style="padding:4px 32px 0;">
              <a href="${input.reportUrl}"
                 style="display:inline-block;padding:12px 22px;background:#6ee7b7;color:#042f1a;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
                See the full report →
              </a>
              <p style="margin:10px 0 0;font-size:12px;line-height:1.6;color:#64748b;">
                <a href="${input.reportUrl}" style="color:#9aa3b2;word-break:break-all;">${input.reportUrl}</a>
              </p>
            </td>
          </tr>`
    : "";

  // Last, after the visible content. A client that stops rendering partway
  // through has already shown the mail, and one that never reaches the pixel
  // was never going to report a meaningful open anyway.
  const pixelRow = input.trackingPixel
    ? `<tr><td style="padding:0;line-height:0;font-size:0;">${input.trackingPixel}</td></tr>`
    : "";

  const innerHtml = `<tr>
            <td style="padding:24px 32px 0;">
              ${paragraphs}
            </td>
          </tr>
          ${reportBlock}
          <tr><td style="padding:0 32px 20px;"></td></tr>
          ${pixelRow}`;

  // Why-you-got-this, opt-out, postal address — the three things a cold
  // commercial email legally and ethically has to carry.
  const footerNote = [
    `You're getting this once because we ran a public scan of ${escapeHtml(input.host)}. No list, no signup — if it's not useful, that's the end of it.`,
    `<a href="${input.unsubscribeUrl}" style="color:#9aa3b2;">Don't contact me again</a> · <a href="${input.unsubscribeUrl}?scope=domain" style="color:#9aa3b2;">or anyone at ${escapeHtml(input.host)}</a>`,
    escapeHtml(input.postalAddress),
  ].join("<br><br>");

  return emailShell({
    title: `About ${input.host}`,
    innerHtml,
    footerNote,
  });
}

/**
 * Daily AI spend warning.
 *
 * Leads with the number and the breakdown, because "you spent $18" prompts
 * the question "on what" and the answer should not require opening a
 * dashboard. States plainly that nothing was stopped, so the mail is not read
 * as an outage.
 */
export async function sendAiSpendAlertEmail(input: {
  to: string;
  day: string;
  spendLabel: string;
  thresholdLabel: string;
  calls: number;
  breakdown: { feature: string; spendLabel: string; calls: number }[];
}): Promise<{ sent: boolean; error?: string }> {
  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };

  const rows = input.breakdown
    .map(
      (b) =>
        `<tr><td style="padding:4px 12px 4px 0">${b.feature}</td>` +
        `<td style="padding:4px 12px 4px 0;text-align:right;font-family:monospace">${b.spendLabel}</td>` +
        `<td style="padding:4px 0;text-align:right;color:#666">${b.calls}</td></tr>`,
    )
    .join("");

  const res = await c.send({
    from: env.resendFrom,
    to: input.to,
    subject: `AI spend ${input.spendLabel} on ${input.day} (over ${input.thresholdLabel})`,
    html: [
      `<p><strong>${input.spendLabel}</strong> of AI usage so far on ${input.day}, across ${input.calls} calls.</p>`,
      `<p>That is over your ${input.thresholdLabel}/day warning line. <strong>Nothing has been stopped</strong> — this is a heads-up, not an outage.</p>`,
      rows
        ? `<table style="border-collapse:collapse;font-size:14px"><thead><tr>` +
          `<th style="text-align:left;padding-right:12px">Feature</th>` +
          `<th style="text-align:right;padding-right:12px">Spend</th>` +
          `<th style="text-align:right;color:#666">Calls</th></tr></thead><tbody>${rows}</tbody></table>`
        : "",
      `<p style="color:#666;font-size:13px">Computed from token counts on each call at published per-model rates. It measures what this app spent, not the balance on the Anthropic account — reading that needs an Admin API key.</p>`,
    ].join(""),
  });
  if (!res.sent) return { sent: false, error: res.error };
  return { sent: true };
}

/**
 * Somebody publicly asked for what you sell.
 *
 * Batched per campaign per sweep, never per signal: a sweep that finds eleven
 * conversations has to produce one email. Eleven would be the fastest way to
 * make the feature something people filter to a folder, and a filtered alert
 * is the same as no alert.
 *
 * The count and the best score go in the subject so it can be triaged from a
 * phone notification without opening anything — the whole point is answering
 * before somebody else does, and a lead worth having has a useful life
 * measured in hours.
 */
export async function sendIntentAlertEmail(input: {
  to: string;
  campaign: string;
  projectUrl: string;
  signals: Array<{
    title: string;
    url: string;
    source: string;
    score: number;
    tier: string;
    reasons: string[];
    postedAt: string | null;
  }>;
}): Promise<{ sent: boolean; error?: string }> {
  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };
  if (!input.signals.length) return { sent: false, error: "nothing to send" };

  const best = Math.max(...input.signals.map((s) => s.score));
  const n = input.signals.length;

  const items = input.signals
    .map((s) => {
      const when = s.postedAt
        ? new Date(s.postedAt).toISOString().slice(0, 16).replace("T", " ")
        : "undated";
      return [
        `<li style="margin:0 0 14px">`,
        `<a href="${s.url}" style="font-weight:600">${escapeHtml(s.title || s.url)}</a><br>`,
        `<span style="font-size:13px;color:#666">`,
        `${s.score}/100 ${escapeHtml(s.tier)} · ${escapeHtml(s.source)} · ${when}`,
        `</span><br>`,
        `<span style="font-size:13px;color:#666">${escapeHtml(s.reasons.slice(0, 3).join(" · "))}</span>`,
        `</li>`,
      ].join("");
    })
    .join("");

  const res = await c.send({
    from: env.resendFrom,
    to: input.to,
    subject:
      n === 1
        ? `1 person asked for what you sell (${best}/100) — ${input.campaign}`
        : `${n} people asked for what you sell (best ${best}/100) — ${input.campaign}`,
    html: [
      `<p>Found by the <strong>${escapeHtml(input.campaign)}</strong> campaign in the last sweep.</p>`,
      `<ul style="padding-left:18px">${items}</ul>`,
      `<p style="font-size:13px;color:#666">Reply where they asked, in public, as a reply — these are people on a platform, not addresses to email. Answering early is most of the advantage.</p>`,
      `<p><a href="${input.projectUrl}">Open the queue</a></p>`,
    ].join(""),
  });
  if (!res.sent) return { sent: false, error: res.error };
  return { sent: true };
}

export async function sendColdOutreachEmail(input: {
  to: string;
  subject: string;
  html: string;
  unsubscribeUrl: string;
  replyTo?: string;
  /**
   * The org's connected mailbox, when there is one. Passing it sends through
   * the user's own SMTP server so the mail comes from their address and
   * replies come back to them; omitting it uses the shared Resend sender.
   */
  mailbox?: SenderMailbox | null;
}): Promise<{
  sent: boolean;
  error?: string;
  provider?: string;
  messageId?: string;
}> {
  const headers = {
    "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  if (input.mailbox) {
    // Imported lazily: nodemailer is only needed on the connected-mailbox
    // path, and every other caller of this module runs without it.
    const { default: nodemailer } = await import("nodemailer");
    try {
      const transporter = nodemailer.createTransport({
        host: input.mailbox.host,
        port: input.mailbox.port,
        secure: input.mailbox.secure,
        auth: { user: input.mailbox.user, pass: input.mailbox.pass },
      });
      // The Message-Id is what a reply names in In-Reply-To. Keeping it is
      // what lets reply detection match by thread rather than by guessing
      // from the sender's domain.
      const info = await transporter.sendMail({
        from: input.mailbox.fromEmail,
        to: input.to,
        subject: input.subject,
        html: input.html,
        replyTo: input.replyTo ?? input.mailbox.replyTo ?? undefined,
        headers,
      });
      transporter.close();
      return { sent: true, provider: "mailbox", messageId: info.messageId };
    } catch (error) {
      // No silent fallback to the shared sender: the user asked for mail to
      // come from their address, and quietly sending as someone else would
      // misrepresent who is contacting the prospect.
      return {
        sent: false,
        provider: "mailbox",
        error: error instanceof Error ? error.message : "Mailbox send failed.",
      };
    }
  }

  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };
  const res = await c.send({
    from: env.resendFrom,
    to: input.to,
    subject: input.subject,
    html: input.html,
    replyTo: input.replyTo,
    headers,
  });
  if (!res.sent) return { sent: false, error: res.error, provider: "resend" };
  return { sent: true, provider: "resend" };
}

/**
 * Admin broadcast. The body arrives as Markdown (or plain text) from
 * /admin/email-broadcast and is rendered by lib/emailMarkdown.ts, which escapes the
 * input and inlines styles matching this shell — see that file for what is supported.
 */
export function broadcastEmailHtml(input: {
  subject: string;
  bodyHtml: string;
}): string {
  const innerHtml = `<tr>
            <td style="padding:24px 32px 0;">
              <h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:800;color:#e7e9ee;">
                ${escapeHtml(input.subject)}
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px 26px;">
              ${input.bodyHtml}
            </td>
          </tr>`;
  return emailShell({
    // emailShell drops `title` straight into <title>, so it is escaped here — the
    // subject is admin-authored free text.
    title: escapeHtml(input.subject),
    innerHtml,
    footerNote: "You're receiving this because you have a CrawlProof account.",
  });
}

// New job application landed in a project's careers inbox.
//
// Every field here is applicant-controlled and arrives from an unauthenticated
// public form, so all of it goes through escapeHtml. The portfolio link is
// rendered as text rather than an anchor: it has been normalized to http(s)
// server-side, but there is no reason to make a stranger's URL one click away
// inside the owner's mail client.
export async function sendCareersApplicationEmail(input: {
  to: string;
  projectName: string;
  jobTitle: string;
  applicantName: string;
  applicantEmail: string;
  link: string | null;
  inboxUrl: string;
}): Promise<{ sent: boolean; error?: string }> {
  const c = client();
  if (!c) return { sent: false, error: "RESEND_API_KEY not set" };

  const linkRow = input.link
    ? `<p style="margin:6px 0 0;font-size:14px;color:#94a3b8;">
         Portfolio / LinkedIn / GitHub:
         <span style="color:#e7e9ee;">${escapeHtml(input.link)}</span>
       </p>`
    : "";

  const innerHtml = `
    <tr>
      <td style="padding:28px 32px 8px;">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#e7e9ee;">New application</h1>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#94a3b8;">
          <strong style="color:#e7e9ee;">${escapeHtml(input.applicantName)}</strong> applied for
          <strong style="color:#e7e9ee;">${escapeHtml(input.jobTitle)}</strong>
          at ${escapeHtml(input.projectName)}.
        </p>
        <p style="margin:0;font-size:14px;color:#94a3b8;">
          Email: <span style="color:#e7e9ee;">${escapeHtml(input.applicantEmail)}</span>
        </p>
        ${linkRow}
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px 32px;">
        <a href="${input.inboxUrl}"
           style="display:inline-block;background:#6ee7b7;color:#042f1a;font-weight:700;font-size:15px;
                  text-decoration:none;padding:12px 28px;border-radius:8px;">
          Review applicant
        </a>
      </td>
    </tr>
  `;

  const res = await c.send({
    from: env.resendFrom,
    to: input.to,
    subject: `New application: ${escapeHtml(input.jobTitle)}`,
    html: emailShell({
      title: `New application for ${input.jobTitle}`,
      innerHtml,
      footerNote: "You're receiving this because you own this CrawlProof project.",
    }),
  });
  if (!res.sent) return { sent: false, error: res.error };
  return { sent: true };
}
