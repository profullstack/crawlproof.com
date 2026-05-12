import { spawn } from "node:child_process";
import { Marked } from "marked";

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
        "--from=gfm-raw_html",
        "--to=html5",
        "--standalone=false",
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

const marked = new Marked({ gfm: true, breaks: false });

export async function markdownToHtml(md: string): Promise<string> {
  if (await pandocAvailable()) {
    try {
      return await pandocConvert(md);
    } catch (err) {
      console.warn("[markdown] pandoc failed, falling back to marked", err);
    }
  }
  return marked.parse(md, { async: false }) as string;
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
    </section>

    ${decorateStatusPills(input.bodyHtml)}
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
