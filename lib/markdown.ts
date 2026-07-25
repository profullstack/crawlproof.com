import { spawn } from "node:child_process";
import { Marked } from "marked";
import { formatHours, formatUsd, type Quote } from "./audit/quote";

// Server-side Markdown → HTML.
//
// Preferred path: pandoc (richer output, tables, table-of-contents). Used when
// the binary is on PATH — installed in the worker Docker image.
// Fallback: `marked` JS library, which runs anywhere (Vercel/serverless).

let _pandocAvailable: boolean | null = null;

async function pandocAvailable(): Promise<boolean> {
  if (_pandocAvailable !== null) return _pandocAvailable;
  _pandocAvailable = await new Promise<boolean>((resolve) => {
    const p = spawn("pandoc", ["--version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
  return _pandocAvailable;
}

async function pandocConvert(md: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "pandoc",
      [
        // gfm-raw_html escapes any literal HTML tags in the source (e.g.
        // `<title>` inside finding strings) instead of passing them through
        // — otherwise browsers interpret a stray `<title>` inside <body> as
        // a head element and silently swallow everything after it.
        // gfm_auto_identifiers slugifies headings with GitHub-style rules
        // so a TOC `[Foo](#foo)` resolves against the rendered
        // `<h2 id="foo">Foo</h2>` without us hand-wiring anchors.
        "--from=gfm-raw_html+gfm_auto_identifiers",
        "--to=html5",
        "--no-highlight",
        "--wrap=none",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`pandoc exited ${code}: ${err}`));
    });
    proc.stdin.end(md);
  });
}

function slugifyHeading(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Custom heading renderer adds GitHub-style anchor IDs so the fallback
// path (used outside the worker container, where pandoc isn't installed)
// also resolves TOC anchor links correctly.
const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    heading({ tokens, depth }: { tokens: unknown[]; depth: number }) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const renderer = (marked as any).Renderer
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this as any)
        : null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (this as any).parser.parseInline(tokens);
      const raw = tokens
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((t: any) => (t && typeof t.raw === "string" ? t.raw : ""))
        .join("");
      void renderer;
      const id = slugifyHeading(raw);
      return `<h${depth}${id ? ` id="${id}"` : ""}>${text}</h${depth}>\n`;
    },
  },
});

// Strip target/rel from anchor tags pointing at in-page anchors
// (`href="#..."` — TOC links and similar). Claude sometimes emits TOC
// items as raw `<a href="#x" target="_blank">…</a>` HTML inside the
// markdown body; both pandoc (with -raw_html) and marked pass through
// inline HTML differently, and we don't want a TOC entry to spawn a
// new tab. External links are left alone.
function dropTargetOnAnchorLinks(html: string): string {
  return html.replace(
    /<a\b([^>]*\bhref\s*=\s*(?:"#[^"]*"|'#[^']*'|#[^\s>]+)[^>]*)>/gi,
    (_match, attrs: string) => {
      const cleaned = attrs
        .replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "")
        .replace(/\s+rel\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "");
      return `<a${cleaned}>`;
    },
  );
}

export async function markdownToHtml(md: string): Promise<string> {
  let html: string;
  if (await pandocAvailable()) {
    try {
      html = await pandocConvert(md);
    } catch (err) {
      console.warn("[markdown] pandoc failed, falling back to marked", err);
      html = marked.parse(md, { async: false }) as string;
    }
  } else {
    html = marked.parse(md, { async: false }) as string;
  }
  return dropTargetOnAnchorLinks(html);
}

// Decorate raw status emoji from the audit Markdown so they render as proper
// inline status pills (rather than as raw "✅" glyphs that look out of place
// next to clean print typography).
function decorateStatusPills(html: string): string {
  return html
    .replace(/✅/g, '<span class="pill pill-pass">PASS</span>')
    .replace(/⚠️/g, '<span class="pill pill-warn">WARN</span>')
    .replace(/❌/g, '<span class="pill pill-fail">FAIL</span>')
    .replace(/❓/g, '<span class="pill pill-unknown">?</span>');
}

// Print-ready HTML wrapper. Used directly by Playwright PDF rendering.
// Designed to look like a polished consulting deliverable, not a webpage.
export function htmlDocument(input: {
  title: string;
  bodyHtml: string;
  meta?: {
    target?: string;
    score?: number;
    generatedAt?: string;
  };
  /**
   * Remediation offer rendered on the cover. Priced from the report's own
   * findings by lib/audit/quote.ts — see quoteFromFindings.
   */
  quote?: Quote;
}): string {
  const meta = input.meta ?? {};
  const score = meta.score;
  const scoreColor =
    score === undefined
      ? "#0f172a"
      : score >= 80
        ? "#059669"
        : score >= 50
          ? "#d97706"
          : "#dc2626";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 11.5pt;
    color: #0f172a;
    background: #ffffff;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .doc {
    max-width: 6.6in;
    margin: 0 auto;
    padding: 0.6in 0.55in 0.5in;
  }
  /* Cover */
  .cover {
    page-break-after: always;
    text-align: left;
    padding: 1.2in 0 0.6in;
    border-bottom: 1px solid #e2e8f0;
    margin-bottom: 0.6in;
  }
  .cover .brand {
    font-size: 11pt;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #059669;
  }
  .cover h1 {
    font-size: 30pt;
    line-height: 1.1;
    margin: 0.4in 0 0.15in;
    letter-spacing: -0.02em;
  }
  .cover .target {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 12pt;
    color: #334155;
    word-break: break-all;
  }
  .cover-row {
    display: flex;
    align-items: center;
    gap: 0.4in;
    margin-top: 0.5in;
  }
  .score-ring {
    width: 1.6in;
    height: 1.6in;
    border-radius: 50%;
    background:
      conic-gradient(${scoreColor} calc(${score ?? 0} * 1%), #e2e8f0 0);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .score-ring-inner {
    width: 1.3in;
    height: 1.3in;
    background: #ffffff;
    border-radius: 50%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .score-ring-inner .value {
    font-size: 28pt;
    font-weight: 800;
    color: ${scoreColor};
    line-height: 1;
  }
  .score-ring-inner .label {
    font-size: 9pt;
    color: #64748b;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-top: 4px;
  }
  /* Remediation offer — the cover's call to action. */
  .quote {
    margin-top: 0.42in;
    border: 1.5pt solid #059669;
    border-radius: 6pt;
    background: #f0fdf9;
    padding: 14pt 16pt;
    page-break-inside: avoid;
  }
  .quote .kicker {
    font-size: 8.5pt;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #047857;
  }
  .quote .amount {
    font-size: 26pt;
    font-weight: 800;
    line-height: 1.1;
    letter-spacing: -0.02em;
    color: #064e3b;
    margin-top: 3pt;
  }
  .quote .amount .unit { font-size: 12pt; font-weight: 600; color: #047857; }
  .quote .promise { font-size: 11pt; color: #14532d; margin-top: 4pt; }
  .quote .split {
    display: flex;
    gap: 18pt;
    margin-top: 11pt;
    padding-top: 10pt;
    border-top: 1px solid #a7f3d0;
  }
  .quote .split div { font-size: 10pt; color: #14532d; }
  .quote .split .h {
    display: block;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 13pt;
    font-weight: 700;
    color: #064e3b;
  }
  .quote .drivers { font-size: 9pt; color: #166534; margin-top: 9pt; line-height: 1.45; }
  .quote .fine { font-size: 8.5pt; color: #3f6212; margin-top: 8pt; }

  .meta-list { font-size: 10.5pt; color: #334155; }
  .meta-list dt { color: #64748b; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.1em; }
  .meta-list dd { margin: 2px 0 12px; padding: 0; font-weight: 600; }

  /* Body */
  h2 {
    font-size: 16pt;
    margin: 28pt 0 8pt;
    padding-bottom: 6pt;
    border-bottom: 1px solid #e2e8f0;
    color: #0f172a;
    page-break-after: avoid;
    letter-spacing: -0.01em;
  }
  h3 { font-size: 12.5pt; margin: 18pt 0 6pt; color: #0f172a; }
  p, li { color: #1f2937; }
  ul { padding-left: 1.1em; }
  li { margin: 4pt 0; }
  strong { color: #0f172a; }
  code {
    background: #f1f5f9;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 90%;
  }
  pre code { display: block; padding: 10pt; overflow-x: auto; background: #f8fafc; }
  hr { border: 0; border-top: 1px solid #e2e8f0; margin: 28pt 0; }
  a { color: #047857; text-decoration: none; }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 10pt 0 14pt;
    font-size: 10.5pt;
  }
  th, td {
    border-bottom: 1px solid #e2e8f0;
    padding: 7pt 9pt;
    text-align: left;
    vertical-align: top;
  }
  th {
    background: #f8fafc;
    font-weight: 600;
    color: #334155;
    text-transform: uppercase;
    font-size: 8.5pt;
    letter-spacing: 0.06em;
  }
  tr { page-break-inside: avoid; }

  .pill {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 8.5pt;
    font-weight: 700;
    letter-spacing: 0.05em;
    vertical-align: 1px;
    margin-right: 4px;
  }
  .pill-pass { background: #dcfce7; color: #166534; }
  .pill-warn { background: #fef3c7; color: #92400e; }
  .pill-fail { background: #fee2e2; color: #991b1b; }
  .pill-unknown { background: #e2e8f0; color: #475569; }

  @page { size: A4; margin: 0.5in; }
  @page:first { margin: 0; }
  @media print {
    body { font-size: 10.5pt; }
    h2, h3 { page-break-after: avoid; }
    li, tr, table, ul { page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="doc">
    <section class="cover">
      <div class="brand">CrawlProof · AEO audit</div>
      <h1>${escapeHtml(input.title)}</h1>
      ${meta.target ? `<div class="target">${escapeHtml(meta.target)}</div>` : ""}
      <div class="cover-row">
        ${
          score !== undefined
            ? `<div class="score-ring"><div class="score-ring-inner">
                 <div class="value">${score}</div>
                 <div class="label">/ 100</div>
               </div></div>`
            : ""
        }
        <dl class="meta-list">
          ${meta.generatedAt ? `<dt>Generated</dt><dd>${escapeHtml(new Date(meta.generatedAt).toLocaleString())}</dd>` : ""}
          <dt>Audit by</dt><dd>CrawlProof · crawlproof.com</dd>
        </dl>
      </div>
      ${input.quote ? quoteBlock(input.quote, meta.target) : ""}
    </section>

    ${decorateStatusPills(input.bodyHtml)}
  </div>
</body>
</html>`;
}

// The cover's "we'll fix this for you" offer. Every number here comes from the
// findings in the report it's printed on, so the quote and the evidence for it
// travel together.
function quoteBlock(q: Quote, target?: string): string {
  const host = (() => {
    if (!target) return "your site";
    try {
      return new URL(target).hostname;
    } catch {
      return target;
    }
  })();

  const drivers = q.drivers
    .slice(0, 4)
    .map((d) => `${escapeHtml(d.label)} ${formatHours(d.aiHours + d.manualHours)}`)
    .join(" · ");

  return `<div class="quote">
        <div class="kicker">Want us to fix this for you?</div>
        <div class="amount">${formatUsd(q.amountUsd)} <span class="unit">USD${q.cappedForScoping ? "+" : ""}</span></div>
        <div class="promise">
          Estimated <strong>${formatHours(q.totalHours)}</strong> at ${formatUsd(q.rateUsd)}/hour to take
          ${escapeHtml(host)} to a <strong>${q.targetScore}%+ score across the board</strong>.
        </div>
        <div class="split">
          <div><span class="h">${formatHours(q.aiHours)}</span>AI-assisted automation</div>
          <div><span class="h">${formatHours(q.manualHours)}</span>Manual engineering</div>
        </div>
        ${drivers ? `<div class="drivers"><strong>Where the time goes:</strong> ${drivers}</div>` : ""}
        <div class="fine">
          Scoped from the ${q.issueCount} open issue${q.issueCount === 1 ? "" : "s"} in this report${
            q.cappedForScoping
              ? ", which exceeds a standard remediation — the final figure is confirmed after a scoping call"
              : ""
          }. Fixed fee, quoted before work starts. Reply to this report or email hello@crawlproof.com.
        </div>
      </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
