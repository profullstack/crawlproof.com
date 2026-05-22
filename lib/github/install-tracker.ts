// Install the CrawlProof stats.js tracker into a customer repo as a
// pull request. Deterministic — no LLM. Walks a priority list of
// "where a layout / shell template lives" and injects the script tag
// just before the first </body> close. Idempotent: short-circuits if the
// snippet (matched on data-site attribute) is already present.

import { env } from "@/lib/env";
import {
  createBranch,
  getFileContent,
  getRepo,
  openPullRequest,
  putFile,
  searchRepoCode,
} from "./repos";

interface InstallInput {
  token: string;
  owner: string;
  repo: string;
  projectId: string;
  /** Optional subdirectory inside a monorepo, e.g. "apps/web" or
   *  "sites/sh1pt.com". Canonical candidate paths get this prefix
   *  before being probed. Leave undefined for single-app repos. */
  rootPath?: string;
}

export interface InstallResult {
  status: "opened" | "noop";
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  path?: string;
  /** Human note for the UI: e.g. "Snippet already present in app/layout.tsx". */
  detail: string;
}

// Candidate paths in priority order. We probe each via the contents API
// (fast — no clone) and pick the first one that contains a </body> tag.
// JSX layouts (Next.js / Astro) work because they render a literal
// </body> in source.
const CANDIDATES: string[] = [
  "app/layout.tsx",
  "app/layout.jsx",
  "src/app/layout.tsx",
  "src/app/layout.jsx",
  "pages/_document.tsx",
  "pages/_document.jsx",
  "src/pages/_document.tsx",
  "src/pages/_document.jsx",
  "src/layouts/Layout.astro",
  "src/layouts/BaseLayout.astro",
  "layouts/_default/baseof.html", // Hugo
  "_layouts/default.html", // Jekyll
  "index.html",
  "public/index.html",
  "src/index.html",
];

const BRANCH_PREFIX = "crawlproof/install-stats-tracker";

function rawScriptTag(projectId: string): string {
  return `<script data-site="${projectId}" src="${env.siteUrl.replace(/\/$/, "")}/stats.js" async></script>`;
}

function nextScriptTag(projectId: string): string {
  return `<Script data-site="${projectId}" src="${env.siteUrl.replace(/\/$/, "")}/stats.js" strategy="afterInteractive" />`;
}

/**
 * Choose the right snippet shape for a target file. For Next.js TSX/JSX
 * layouts we use the <Script> component (next/script) — idiomatic and
 * avoids hydration warnings about an inline <script>. Everything else
 * gets a plain HTML <script> tag.
 */
function snippetForPath(projectId: string, path: string): string {
  return /\.(tsx|jsx)$/.test(path)
    ? nextScriptTag(projectId)
    : rawScriptTag(projectId);
}

/**
 * Return content with the snippet inserted before the first </body>, or
 * null if there's no </body> in the file. Adds `import Script from "next/script"`
 * at the top of TSX/JSX files when needed.
 */
function injectBeforeBodyClose(
  content: string,
  snippet: string,
  path: string,
): string | null {
  const re = /<\/body>/i;
  const match = content.match(re);
  if (!match || match.index == null) return null;
  const idx = match.index;
  // Preserve any leading whitespace on the </body> line for clean
  // indentation in the diff.
  const prefix = content.slice(0, idx);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  const indent = prefix.slice(lineStart).match(/^\s*/)?.[0] ?? "";
  let updated = `${prefix}${indent}  ${snippet}\n${indent}${content.slice(idx)}`;

  // For Next.js layouts: add `import Script from "next/script"` if it
  // isn't already imported. Skip if the file already pulls Script in
  // from any source.
  if (/\.(tsx|jsx)$/.test(path) && /<Script\b/.test(snippet)) {
    if (!/from\s+["']next\/script["']/.test(updated)) {
      updated = addNextScriptImport(updated);
    }
  }
  return updated;
}

/**
 * Insert `import Script from "next/script";` after the last top-level
 * import statement. Falls back to the top of the file if none.
 */
function addNextScriptImport(content: string): string {
  const importLine = `import Script from "next/script";\n`;
  // Find the line index of the LAST line that starts with `import `.
  const lines = content.split("\n");
  let lastImportLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\b/.test(lines[i])) lastImportLine = i;
  }
  if (lastImportLine === -1) {
    return importLine + content;
  }
  lines.splice(lastImportLine + 1, 0, importLine.replace(/\n$/, ""));
  return lines.join("\n");
}

/** Strip leading/trailing slashes so we can confidently join with "/". */
function normalizeRoot(p: string | undefined): string {
  if (!p) return "";
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

export async function installTracker(input: InstallInput): Promise<InstallResult> {
  const repoMeta = await getRepo({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
  });
  const base = repoMeta.default_branch;
  const projectIdMarker = `data-site="${input.projectId}"`;

  const root = normalizeRoot(input.rootPath);
  const candidates = root
    ? CANDIDATES.map((p) => `${root}/${p}`)
    : CANDIDATES;

  // Probe a path: returns the file if it has </body> AND doesn't already
  // have our snippet; signals "already installed" if it does.
  type ProbeResult =
    | { kind: "hit"; file: { path: string; sha: string; content: string } }
    | { kind: "already"; path: string }
    | { kind: "miss" };
  const probe = async (path: string): Promise<ProbeResult> => {
    const file = await getFileContent({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path,
      ref: base,
    });
    if (!file) return { kind: "miss" };
    if (file.content.includes(projectIdMarker)) {
      return { kind: "already", path: file.path };
    }
    if (/<\/body>/i.test(file.content)) {
      return { kind: "hit", file };
    }
    return { kind: "miss" };
  };

  // 1. Try the canonical candidate list (optionally prefixed by rootPath).
  let target: { path: string; sha: string; content: string } | null = null;
  for (const path of candidates) {
    const r = await probe(path);
    if (r.kind === "already") {
      return {
        status: "noop",
        path: r.path,
        detail: `Tracker already installed at ${r.path}.`,
      };
    }
    if (r.kind === "hit") {
      target = r.file;
      break;
    }
  }

  // 2. Fallback: ask GitHub's code search for any file containing </body>
  //    in this repo. Handles monorepos (e.g. apps/web/app/layout.tsx,
  //    sites/foo/app/layout.tsx) and non-standard frameworks
  //    (SvelteKit src/app.html, Remix app/root.tsx, ...).
  if (!target) {
    try {
      const hits = await searchRepoCode({
        token: input.token,
        owner: input.owner,
        repo: input.repo,
        query: "</body>",
      });
      // If a root path is configured, prefer hits inside it.
      const ordered = root
        ? [
            ...hits.filter((h) => h.path.startsWith(root + "/")),
            ...hits.filter((h) => !h.path.startsWith(root + "/")),
          ]
        : hits;
      for (const hit of ordered) {
        const r = await probe(hit.path);
        if (r.kind === "already") {
          return {
            status: "noop",
            path: r.path,
            detail: `Tracker already installed at ${r.path}.`,
          };
        }
        if (r.kind === "hit") {
          target = r.file;
          break;
        }
      }
    } catch (err) {
      // Code search failure is non-fatal — fall through to the error
      // path below with a clearer message.
      console.warn("[install-tracker] code search failed:", err);
    }
  }

  if (!target) {
    const probed = candidates.join(", ");
    const hint = root
      ? `Looked under root "${root}". Try a different root path or open an issue with your repo layout.`
      : "Monorepo? Set a root path on the project's Repos tab to point at the app directory (e.g. apps/web).";
    throw new Error(
      `No template file with </body> found in ${input.owner}/${input.repo}. Probed canonical paths: ${probed}. ${hint}`,
    );
  }

  // Compute the new content. Snippet shape (Next.js <Script> vs raw
  // <script>) depends on the target file extension.
  const snippet = snippetForPath(input.projectId, target.path);
  const updated = injectBeforeBodyClose(target.content, snippet, target.path);
  if (!updated) {
    throw new Error(
      `Could not locate </body> in ${target.path} after second pass.`,
    );
  }

  // 3. Create a fresh branch off default.
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const branch = `${BRANCH_PREFIX}-${ts}`;
  await createBranch({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    newBranch: branch,
    fromBranch: base,
  });

  // 4. Push the edit.
  await putFile({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    path: target.path,
    branch,
    message: "Add CrawlProof stats tracker",
    contentUtf8: updated,
    sha: target.sha,
  });

  // 5. Open the PR.
  const pr = await openPullRequest({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    head: branch,
    base,
    title: "Add CrawlProof stats tracker",
    body: prBody(input.projectId, target.path, snippet),
  });

  return {
    status: "opened",
    prUrl: pr.html_url,
    prNumber: pr.number,
    branch,
    path: target.path,
    detail: `Inserted snippet before </body> in ${target.path}.`,
  };
}

function prBody(projectId: string, path: string, snippet: string): string {
  const isNextScript = /<Script\b/.test(snippet);
  void projectId;
  const importNote = isNextScript
    ? "\n\nThe diff also imports `Script` from `next/script` if it wasn't already imported.\n"
    : "";
  return `This PR adds the [CrawlProof](https://crawlproof.com) stats tracker to your site.

**What it does:** counts pageviews by source — AI engine referrals (ChatGPT, Perplexity, Claude, Gemini…) and AI crawler hits (GPTBot, ClaudeBot, PerplexityBot…). No cookies. No PII. Rolls up to a daily counter on the CrawlProof Stats tab for your project.

**What changed:** one line added to \`${path}\`, just before \`</body>\`:

\`\`\`${isNextScript ? "tsx" : "html"}
${snippet}
\`\`\`${importNote}

**Docs:** ${env.siteUrl}/docs/stats-tracker
**Disable:** flip the tracker off on your CrawlProof project Stats tab and the script becomes a no-op (or remove this line).`;
}
