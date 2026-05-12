import { spawn } from "node:child_process";
import { Marked } from "marked";

// Server-side Markdown → HTML.
//
// Preferred path: pandoc (richer output, tables, table-of-contents). Used when
// the binary is on PATH — typically only in the worker Docker image.
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
        "--from=gfm",
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

const marked = new Marked({
  gfm: true,
  breaks: false,
});

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

// Wrap converted HTML in a standalone, print-friendly document.
export function htmlDocument(input: { title: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.title)}</title>
<style>
  :root { color-scheme: light; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #0c0e12;
    background: #ffffff;
    max-width: 760px;
    margin: 2rem auto;
    padding: 0 1.5rem;
    line-height: 1.55;
  }
  h1 { font-size: 2rem; margin-top: 0; }
  h2 { margin-top: 2.2rem; padding-top: 0.6rem; border-top: 1px solid #e5e7eb; }
  h3 { margin-top: 1.5rem; }
  code { background: #f3f4f6; padding: 0.1rem 0.35rem; border-radius: 0.25rem; }
  pre code { display: block; padding: 0.75rem; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { border: 1px solid #e5e7eb; padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; }
  th { background: #f9fafb; }
  ul { padding-left: 1.4rem; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 2rem 0; }
  a { color: #047857; }
  @media print {
    body { margin: 0; max-width: none; padding: 0 0.3in; }
    h2 { page-break-before: auto; }
    li, tr { page-break-inside: avoid; }
  }
</style>
</head>
<body>
${input.bodyHtml}
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
