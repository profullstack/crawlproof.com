// One batched digest per user per check cycle. Every pending finding across
// ALL of a user's alerts goes into a single email, grouped by alert — never
// one email per alert (50 alerts × daily would be up to 50 emails/day/user, a
// deliverability and fatigue hazard). An empty digest is never sent.

import { env } from "@/lib/env";
import { pauseUrl, unsubscribeUrl } from "./tokens";

export type DigestFinding = {
  title: string | null;
  url: string;
  snippet: string | null;
  confirmed_backlink: boolean;
};

export type DigestGroup = {
  alertId: string;
  label: string;
  category: string;
  findings: DigestFinding[];
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findingRow(f: DigestFinding): string {
  const title = esc(f.title || f.url);
  const snippet = f.snippet ? `<p style="margin:4px 0 0;font-size:13px;line-height:1.55;color:#94a3b8;">${esc(f.snippet)}</p>` : "";
  const badge = f.confirmed_backlink
    ? `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;background:#0e2a1c;color:#6ee7b7;font-size:10px;vertical-align:middle;">link confirmed</span>`
    : "";
  return `<tr><td style="padding:10px 0;border-bottom:1px solid #1f2630;">
    <a href="${esc(f.url)}" style="color:#7dd3fc;font-size:14px;font-weight:600;text-decoration:none;">${title}</a>${badge}
    <div style="margin-top:2px;font-size:11px;color:#475569;word-break:break-all;">${esc(f.url)}</div>
    ${snippet}
  </td></tr>`;
}

function groupBlock(g: DigestGroup): string {
  const rows = g.findings.map(findingRow).join("");
  const count = g.findings.length;
  return `<tr><td style="padding:20px 32px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td>
        <div style="font-size:15px;font-weight:700;color:#e7e9ee;">${esc(g.label)}
          <span style="color:#64748b;font-weight:500;font-size:13px;">· ${count} new</span>
        </div>
      </td><td align="right">
        <a href="${pauseUrl(g.alertId)}" style="font-size:11px;color:#64748b;text-decoration:underline;">Pause this alert</a>
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;">${rows}</table>
  </td></tr>`;
}

export function buildDigest(input: {
  ownerId: string;
  groups: DigestGroup[];
}): { subject: string; html: string; text: string } {
  const total = input.groups.reduce((n, g) => n + g.findings.length, 0);
  const alertWord = input.groups.length === 1 ? "alert" : "alerts";
  const subject =
    input.groups.length === 1
      ? `${total} new for “${input.groups[0].label}”`
      : `${total} new results across ${input.groups.length} ${alertWord}`;

  const manage = `${env.siteUrl}/alerts`;
  const unsub = unsubscribeUrl(input.ownerId);
  const blocks = input.groups.map(groupBlock).join("");

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#0b0d10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e7e9ee;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b0d10;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#12161c;border:1px solid #1f2630;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:26px 32px 6px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="padding-right:10px;vertical-align:middle;"><div style="width:10px;height:10px;background:#6ee7b7;border-radius:999px;"></div></td>
            <td style="vertical-align:middle;color:#e7e9ee;font-weight:700;font-size:16px;">CrawlProof Alerts</td>
          </tr></table>
        </td></tr>
        ${blocks}
        <tr><td style="padding:22px 32px 26px;border-top:1px solid #1f2630;">
          <a href="${manage}" style="display:inline-block;padding:9px 16px;background:#6ee7b7;color:#042f1a;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none;">Manage alerts</a>
          <p style="margin:14px 0 0;font-size:11px;line-height:1.6;color:#475569;">
            You’re getting this because you set up alerts on CrawlProof.
            <a href="${unsub}" style="color:#64748b;">Unsubscribe from all alerts</a>.
          </p>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:#475569;">CrawlProof · See your site the way AI crawlers do.<br>
        <a href="${env.siteUrl}" style="color:#64748b;">${env.siteUrl}</a></p>
    </td></tr>
  </table>
</body></html>`;

  const textLines: string[] = [`${subject}`, ""];
  for (const g of input.groups) {
    textLines.push(`## ${g.label} (${g.findings.length} new)`);
    for (const f of g.findings) {
      textLines.push(`- ${f.title || f.url}${f.confirmed_backlink ? " [link confirmed]" : ""}`);
      textLines.push(`  ${f.url}`);
    }
    textLines.push("");
  }
  textLines.push(`Manage alerts: ${manage}`);
  textLines.push(`Unsubscribe: ${unsub}`);
  const text = textLines.join("\n");

  return { subject, html, text };
}
