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
