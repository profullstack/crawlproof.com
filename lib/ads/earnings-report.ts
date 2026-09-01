import { dollars, type EarningsModel } from "./earnings-data";

// Build a self-contained, print-friendly HTML report of ad spend & earnings.
// Rendered to PDF by the worker's Playwright /pdf endpoint (html branch), so it
// must be a complete document with inline styles and no external assets. The
// chart is inline SVG (no recharts) so it prints reliably.

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ctr(clicks: number, impressions: number): string {
  return impressions ? `${((clicks / impressions) * 100).toFixed(1)}%` : "—";
}

// Two-line inline-SVG chart (earnings vs spend) over the daily series.
function chartSvg(daily: EarningsModel["daily"]): string {
  const w = 720;
  const h = 200;
  const pad = { top: 10, right: 10, bottom: 22, left: 44 };
  const iw = w - pad.left - pad.right;
  const ih = h - pad.top - pad.bottom;
  const n = daily.length;
  const max = Math.max(1, ...daily.map((d) => Math.max(d.spentCents, d.earnedCents)));
  const x = (i: number) => pad.left + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = (cents: number) => pad.top + ih - (cents / max) * ih;
  const line = (key: "spentCents" | "earnedCents") =>
    daily.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(" ");
  const gridY = [0, 0.5, 1].map((f) => {
    const yy = pad.top + ih - f * ih;
    const val = (max * f) / 100;
    return `<line x1="${pad.left}" y1="${yy}" x2="${w - pad.right}" y2="${yy}" stroke="#e2e8f0" stroke-width="1"/>
      <text x="${pad.left - 6}" y="${yy + 3}" text-anchor="end" font-size="9" fill="#94a3b8">$${val.toFixed(0)}</text>`;
  });
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img">
    ${gridY.join("")}
    <path d="${line("earnedCents")}" fill="none" stroke="#0ea472" stroke-width="2"/>
    <path d="${line("spentCents")}" fill="none" stroke="#f59e0b" stroke-width="2"/>
    <text x="${pad.left}" y="${h - 6}" font-size="9" fill="#94a3b8">${esc(daily[0]?.date ?? "")}</text>
    <text x="${w - pad.right}" y="${h - 6}" text-anchor="end" font-size="9" fill="#94a3b8">${esc(
      daily[n - 1]?.date ?? "",
    )}</text>
  </svg>`;
}

export function buildEarningsReportHtml(input: {
  model: EarningsModel;
  account: string;
  generatedAt: string; // ISO
}): string {
  const { model, account, generatedAt } = input;
  const t = model.totals;
  const gen = new Date(generatedAt);
  const from = model.daily[0]?.date ?? "";
  const to = model.daily[model.daily.length - 1]?.date ?? "";

  const summaryRow = (label: string, value: string, strong = false) =>
    `<tr><td>${esc(label)}</td><td class="num${strong ? " strong" : ""}">${esc(value)}</td></tr>`;

  const campaignRows =
    model.campaigns.length === 0
      ? `<tr><td colspan="5" class="muted">No ad campaigns.</td></tr>`
      : model.campaigns
          .map(
            (c) =>
              `<tr><td>${esc(c.name)}</td><td>${esc(c.status)}</td><td class="num">${c.impressions.toLocaleString()}</td><td class="num">${c.clicks.toLocaleString()}</td><td class="num">${esc(
                dollars(c.spentCents),
              )}</td></tr>`,
          )
          .join("");

  const slotRows =
    model.slots.length === 0
      ? `<tr><td colspan="5" class="muted">No monetized sites.</td></tr>`
      : model.slots
          .map(
            (s) =>
              `<tr><td>${esc(s.name)}</td><td>${esc(s.status)}</td><td class="num">${s.impressions.toLocaleString()}</td><td class="num">${s.clicks.toLocaleString()}</td><td class="num">${esc(
                dollars(s.earnedCents),
              )}</td></tr>`,
          )
          .join("");

  const payoutRows =
    model.payouts.length === 0
      ? `<tr><td colspan="4" class="muted">No payouts yet.</td></tr>`
      : model.payouts
          .map(
            (p) =>
              `<tr><td>${esc(new Date(p.createdAt).toLocaleDateString())}</td><td class="num">${esc(
                dollars(p.amountCents),
              )}</td><td>${esc(p.currency.toUpperCase())}</td><td>${esc(p.status)}${
                p.txHash ? ` · <span class="mono">${esc(p.txHash.slice(0, 12))}…</span>` : ""
              }</td></tr>`,
          )
          .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>CrawlProof Ads — Earnings &amp; Spend</title>
  <style>
    * { box-sizing: border-box; }
    body { font: 13px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 32px; }
    h1 { font-size: 22px; margin: 0 0 2px; }
    h2 { font-size: 15px; margin: 26px 0 8px; border-bottom: 2px solid #0ea472; padding-bottom: 4px; }
    .sub { color: #64748b; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px; }
    th { color: #64748b; font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: .04em; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    td.strong { font-weight: 700; }
    .muted { color: #94a3b8; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .tiles { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
    .tile { flex: 1 1 150px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; }
    .tile .k { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; }
    .tile .v { font-size: 20px; font-weight: 700; margin-top: 2px; }
    .pos { color: #0ea472; } .neg { color: #dc2626; }
    .chart { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; margin-top: 10px; }
    .legend { display: flex; gap: 16px; font-size: 11px; color: #475569; margin-top: 4px; }
    .dot { display: inline-block; width: 10px; height: 3px; vertical-align: middle; margin-right: 4px; border-radius: 2px; }
    footer { margin-top: 28px; color: #94a3b8; font-size: 11px; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  </style></head><body>
    <h1>CrawlProof Ads — Earnings &amp; Spend</h1>
    <div class="sub">Account: ${esc(account)} · Period: ${esc(from)} → ${esc(to)} (${model.rangeDays} days) · Generated ${esc(
      gen.toLocaleString(),
    )}</div>
    ${
      // A report that says "0 impressions" because a query was cancelled is
      // worse than one that admits it could not read them: this document gets
      // handed to accountants and teams, where a silent zero is taken as fact.
      model.statsUnavailable
        ? `<div class="sub" style="color:#b45309">Delivery figures for this period could not be loaded and are shown as zero. Regenerate this report before relying on the impression and click columns.</div>`
        : ""
    }

    <div class="tiles">
      <div class="tile"><div class="k">Total earned</div><div class="v pos">${esc(dollars(t.earnedCents))}</div></div>
      <div class="tile"><div class="k">Total spend</div><div class="v">${esc(dollars(t.spentCents))}</div></div>
      <div class="tile"><div class="k">Net</div><div class="v ${t.netCents >= 0 ? "pos" : "neg"}">${esc(
        dollars(t.netCents),
      )}</div></div>
      <div class="tile"><div class="k">Available to withdraw</div><div class="v">${esc(
        dollars(t.availableCents),
      )}</div></div>
    </div>

    <h2>Spend &amp; earnings over time</h2>
    <div class="chart">
      ${chartSvg(model.daily)}
      <div class="legend"><span><span class="dot" style="background:#0ea472"></span>Earnings</span><span><span class="dot" style="background:#f59e0b"></span>Spend</span></div>
    </div>

    <h2>Summary</h2>
    <table>
      <tbody>
        ${summaryRow("Total earned (publisher)", dollars(t.earnedCents), true)}
        ${summaryRow("Total spend (advertiser)", dollars(t.spentCents), true)}
        ${summaryRow("Net position", dollars(t.netCents), true)}
        ${summaryRow("Withdrawn to date", dollars(t.withdrawnCents))}
        ${summaryRow("Available to withdraw", dollars(t.availableCents))}
        ${summaryRow("Earned today", dollars(t.earnedTodayCents))}
        ${summaryRow("Spent today", dollars(t.spendTodayCents))}
        ${summaryRow("Publisher impressions / clicks", `${t.pubImpressions.toLocaleString()} / ${t.pubClicks.toLocaleString()} (CTR ${ctr(t.pubClicks, t.pubImpressions)})`)}
        ${summaryRow("Advertiser impressions / clicks", `${t.advImpressions.toLocaleString()} / ${t.advClicks.toLocaleString()} (CTR ${ctr(t.advClicks, t.advImpressions)})`)}
      </tbody>
    </table>

    <h2>Earnings by site (publisher)</h2>
    <table>
      <thead><tr><th>Site</th><th>Status</th><th class="num">Impressions</th><th class="num">Clicks</th><th class="num">Earned</th></tr></thead>
      <tbody>${slotRows}</tbody>
    </table>

    <h2>Spend by campaign (advertiser)</h2>
    <table>
      <thead><tr><th>Campaign</th><th>Status</th><th class="num">Impressions</th><th class="num">Clicks</th><th class="num">Spent</th></tr></thead>
      <tbody>${campaignRows}</tbody>
    </table>

    <h2>Payout history</h2>
    <table>
      <thead><tr><th>Date</th><th class="num">Amount</th><th>Currency</th><th>Status</th></tr></thead>
      <tbody>${payoutRows}</tbody>
    </table>

    <footer>Generated by CrawlProof · crawlproof.com · Figures are point-in-time and for informational purposes.</footer>
  </body></html>`;
}
