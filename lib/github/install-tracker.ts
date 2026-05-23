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
  /** Explicit target file (e.g. "apps/web/src/app/layout.tsx"). When set,
   *  discovery is skipped — we install at exactly this path. Used by
   *  the UI's confirmation step so the user picks the file. */
  targetPath?: string;
}

export interface InstallResult {
  status: "opened" | "noop";
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  path?: string;
  cspPaths?: string[];
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

// Extra whole-repo probes for common monorepos. These only apply when
// rootPath is blank; when the user sets rootPath="apps/web", the base
// candidates above already expand to apps/web/src/app/layout.tsx.
const COMMON_MONOREPO_CANDIDATES: string[] = [
  "apps/web/app/layout.tsx",
  "apps/web/app/layout.jsx",
  "apps/web/src/app/layout.tsx",
  "apps/web/src/app/layout.jsx",
];

const BRANCH_PREFIX = "crawlproof/install-stats-tracker";
const TRACKER_ORIGIN = env.siteUrl.replace(/\/$/, "");

const CSP_CANDIDATES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "next.config.mts",
  "vercel.json",
  "netlify.toml",
  "_headers",
  "public/_headers",
  "static/_headers",
  "middleware.ts",
  "middleware.js",
  "src/middleware.ts",
  "src/middleware.js",
  "proxy.ts",
  "proxy.js",
  "src/proxy.ts",
  "src/proxy.js",
];

const CSP_PATH_RE =
  /(^|\/)(next\.config\.(?:[cm]?[jt]s|mts)|vercel\.json|netlify\.toml|_headers|(?:src\/)?(?:middleware|proxy)\.[jt]s)$/i;

function rawScriptTag(projectId: string): string {
  return `<script data-site="${projectId}" src="${TRACKER_ORIGIN}/stats.js" async></script>`;
}

function nextScriptTag(projectId: string): string {
  return `<Script data-site="${projectId}" src="${TRACKER_ORIGIN}/stats.js" strategy="afterInteractive" />`;
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

function candidatePaths(root: string): string[] {
  const paths = root
    ? CANDIDATES.map((p) => `${root}/${p}`)
    : [...CANDIDATES, ...COMMON_MONOREPO_CANDIDATES];
  return [...new Set(paths)];
}

function cspCandidatePaths(root: string): string[] {
  const paths = root
    ? CSP_CANDIDATES.map((p) => `${root}/${p}`)
    : CSP_CANDIDATES;
  return [...new Set(paths)];
}

// Ranks a candidate path. Higher is better. The picker uses this to
// surface the right file by default instead of (say) the boilerplate
// under examples/. Tuned for monorepos where the production app lives
// at apps/* or sites/*.
function rankCandidatePath(path: string, repoName: string): number {
  let score = 0;
  // Strong negatives — almost never the live site's template.
  if (/(^|\/)(boilerplates?|examples?|templates?|samples?|fixtures?|__tests__|tests?|spec|stories|playground|sandbox|demo|node_modules)(\/|$)/i.test(path)) {
    score -= 100;
  }
  // Penalize markdown / docs paths just in case.
  if (/(^|\/)(docs?|documentation)(\/|$)/i.test(path)) score -= 20;
  // Likely a real app dir.
  if (/(^|\/)apps\//i.test(path)) score += 30;
  if (/(^|\/)sites\//i.test(path)) score += 30;
  if (/(^|\/)web(\/|$)/i.test(path)) score += 20;
  // Repo-name match boosts (e.g. sites/sh1pt.com beats sites/foo when
  // repo is "sh1pt").
  const lower = path.toLowerCase();
  const nameLower = repoName.toLowerCase();
  if (lower.includes(nameLower)) score += 25;
  // Root-level template files always come first when present.
  if (!path.includes("/")) score += 50;
  // Next.js App Router is more common than Pages — slight nudge.
  if (/\/app\/layout\.(tsx|jsx)$/.test(path)) score += 10;
  // Shorter paths slightly preferred (closer to root = more canonical).
  score -= path.length * 0.05;
  return score;
}

export interface InstallCandidate {
  path: string;
  /** Score from rankCandidatePath — debug / explainer. */
  score: number;
  /** Bytes of the file; helps the UI hint at "is this a real app file?". */
  sizeBytes?: number;
}

/**
 * Probe + rank all the candidate template files in a repo. Returns the
 * list sorted best-first so the UI can show the top pick with the rest
 * as alternatives.
 */
export async function findInstallCandidates(input: {
  token: string;
  owner: string;
  repo: string;
  rootPath?: string;
}): Promise<InstallCandidate[]> {
  const repoMeta = await getRepo({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
  });
  const ref = repoMeta.default_branch;
  const root = normalizeRoot(input.rootPath);
  const canonical = candidatePaths(root);

  const found = new Map<string, { sizeBytes?: number }>();

  // Probe the canonical list — cheap, no rate limit on contents API.
  for (const path of canonical) {
    const file = await getFileContent({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path,
      ref,
    });
    if (file && /<\/body>/i.test(file.content)) {
      found.set(file.path, { sizeBytes: file.content.length });
    }
  }

  // Expand with code search hits — handles monorepos / unusual layouts.
  try {
    const hits = await searchRepoCode({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      query: "</body>",
    });
    for (const h of hits) {
      if (!found.has(h.path)) found.set(h.path, {});
    }
  } catch {
    // Search is a fallback; tolerate failure.
  }

  const ranked: InstallCandidate[] = [...found.entries()].map(([path, meta]) => ({
    path,
    score: rankCandidatePath(path, input.repo),
    sizeBytes: meta.sizeBytes,
  }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/**
 * Generate the would-be diff preview for installing the tracker at a
 * specific path. Used by the UI to confirm before opening the PR.
 */
export async function previewInstallAtPath(input: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  projectId: string;
}): Promise<
  | { status: "already_installed"; path: string }
  | {
      status: "ready";
      path: string;
      snippet: string;
      before: string;
      after: string;
      addsImport: boolean;
    }
  | { status: "not_a_template"; path: string; reason: string }
> {
  const repoMeta = await getRepo({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
  });
  const file = await getFileContent({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    path: input.path,
    ref: repoMeta.default_branch,
  });
  if (!file) {
    return { status: "not_a_template", path: input.path, reason: "File not found." };
  }
  const projectIdMarker = `data-site="${input.projectId}"`;
  if (file.content.includes(projectIdMarker)) {
    return { status: "already_installed", path: file.path };
  }
  if (!/<\/body>/i.test(file.content)) {
    return {
      status: "not_a_template",
      path: file.path,
      reason: "No </body> tag in this file.",
    };
  }
  const snippet = snippetForPath(input.projectId, file.path);
  const after = injectBeforeBodyClose(file.content, snippet, file.path);
  if (!after) {
    return {
      status: "not_a_template",
      path: file.path,
      reason: "Couldn't locate </body> after injection pass.",
    };
  }
  const addsImport =
    /\.(tsx|jsx)$/.test(file.path) &&
    /<Script\b/.test(snippet) &&
    !/from\s+["']next\/script["']/.test(file.content);
  return {
    status: "ready",
    path: file.path,
    snippet,
    before: file.content,
    after,
    addsImport,
  };
}

function addSourceToDirective(content: string, directive: string, source: string) {
  const re = new RegExp(
    `(${directive}\\b[^;"\`\\n\\r]*)(?=[;"\`\\n\\r]|$)`,
    "gi",
  );
  let changed = false;
  const next = content.replace(re, (match) => {
    if (new RegExp(`(^|\\s)${escapeRegExp(source)}(?=\\s|$)`).test(match)) {
      return match;
    }
    changed = true;
    return `${match.trimEnd()} ${source}`;
  });
  return changed ? next : content;
}

function hasDirective(content: string, directive: string) {
  return new RegExp(`${directive}\\b`, "i").test(content);
}

function looksLikeCsp(content: string) {
  return /Content-Security-Policy|script-src|script-src-elem|default-src|connect-src/i.test(
    content,
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Patch a common CSP string/config file so CrawlProof can load the tracker
 * script and post events. This is intentionally conservative: it only edits
 * files that already look like CSP config, and only appends our origin to
 * existing directives. If a site has no connect-src, default-src is the
 * fallback for fetch, so we add the origin there too.
 */
export function patchCspForTracker(content: string): string | null {
  if (!looksLikeCsp(content)) return null;

  let updated = content;
  if (hasDirective(updated, "script-src")) {
    updated = addSourceToDirective(updated, "script-src", TRACKER_ORIGIN);
  } else if (hasDirective(updated, "default-src")) {
    updated = addSourceToDirective(updated, "default-src", TRACKER_ORIGIN);
  }

  if (hasDirective(updated, "script-src-elem")) {
    updated = addSourceToDirective(updated, "script-src-elem", TRACKER_ORIGIN);
  }

  if (hasDirective(updated, "connect-src")) {
    updated = addSourceToDirective(updated, "connect-src", TRACKER_ORIGIN);
  } else if (hasDirective(updated, "default-src")) {
    updated = addSourceToDirective(updated, "default-src", TRACKER_ORIGIN);
  }

  return updated === content ? null : updated;
}

async function findCspPatchTargets(input: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
  root: string;
}) {
  const found = new Map<
    string,
    { path: string; sha: string; content: string; updated: string }
  >();

  const tryPath = async (path: string) => {
    if (!CSP_PATH_RE.test(path)) return;
    if (found.has(path)) return;
    const file = await getFileContent({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path,
      ref: input.ref,
    });
    if (!file) return;
    const updated = patchCspForTracker(file.content);
    if (updated) {
      found.set(file.path, { ...file, updated });
    }
  };

  for (const path of cspCandidatePaths(input.root)) {
    await tryPath(path);
  }

  try {
    const hits = await searchRepoCode({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      query: "Content-Security-Policy",
      perPage: 20,
    });
    for (const hit of hits) {
      if (input.root && !hit.path.startsWith(`${input.root}/`)) continue;
      await tryPath(hit.path);
    }
  } catch {
    // Code search is a best-effort fallback; canonical paths still cover
    // common Next/Vercel/Netlify setups.
  }

  return [...found.values()];
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
  const candidates = candidatePaths(root);

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

  let target: { path: string; sha: string; content: string } | null = null;
  let alreadyInstalledPath: string | null = null;

  // If the caller pinned an explicit targetPath, skip discovery
  // entirely — that's the path we install at. The UI uses this after
  // the user confirms the file shown in the preview step.
  if (input.targetPath) {
    const r = await probe(input.targetPath);
    if (r.kind === "already") {
      alreadyInstalledPath = r.path;
    }
    if (r.kind === "miss") {
      throw new Error(
        `Couldn't install at "${input.targetPath}": file not found or has no </body> tag.`,
      );
    }
    if (r.kind === "hit") target = r.file;
  }

  // 1. Try the canonical candidate list (optionally prefixed by rootPath).
  for (const path of !target ? candidates : []) {
    const r = await probe(path);
    if (r.kind === "already") {
      alreadyInstalledPath = r.path;
      break;
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
          alreadyInstalledPath = r.path;
          break;
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

  if (!target && !alreadyInstalledPath) {
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
  const snippet = target ? snippetForPath(input.projectId, target.path) : null;
  const updated = target
    ? injectBeforeBodyClose(target.content, snippet!, target.path)
    : null;
  if (target && !updated) {
    throw new Error(
      `Could not locate </body> in ${target.path} after second pass.`,
    );
  }

  const cspPatches = await findCspPatchTargets({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    ref: base,
    root,
  });

  if (!target && cspPatches.length === 0) {
    return {
      status: "noop",
      path: alreadyInstalledPath ?? undefined,
      detail: alreadyInstalledPath
        ? `Tracker already installed at ${alreadyInstalledPath}. No CSP updates needed.`
        : "Tracker already installed. No CSP updates needed.",
    };
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
  if (target && updated) {
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
  }

  for (const patch of cspPatches) {
    await putFile({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path: patch.path,
      branch,
      message: "Allow CrawlProof stats in CSP",
      contentUtf8: patch.updated,
      sha: patch.sha,
    });
  }

  // 5. Open the PR.
  const pr = await openPullRequest({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    head: branch,
    base,
    title: target
      ? "Add CrawlProof stats tracker"
      : "Allow CrawlProof stats tracker",
    body: prBody({
      path: target?.path ?? alreadyInstalledPath ?? null,
      snippet,
      cspPaths: cspPatches.map((patch) => patch.path),
      alreadyInstalled: !target,
    }),
  });

  const cspPaths = cspPatches.map((patch) => patch.path);
  const cspDetail = cspPaths.length
    ? ` Patched CSP in ${cspPaths.join(", ")}.`
    : "";
  return {
    status: "opened",
    prUrl: pr.html_url,
    prNumber: pr.number,
    branch,
    path: target?.path ?? alreadyInstalledPath ?? undefined,
    cspPaths,
    detail: target
      ? `Inserted snippet before </body> in ${target.path}.${cspDetail}`
      : `Tracker already installed at ${alreadyInstalledPath}.${cspDetail}`,
  };
}

function prBody(input: {
  path: string | null;
  snippet: string | null;
  cspPaths: string[];
  alreadyInstalled: boolean;
}): string {
  const isNextScript = !!input.snippet && /<Script\b/.test(input.snippet);
  const importNote = isNextScript
    ? "\n\nThe diff also imports `Script` from `next/script` if it wasn't already imported.\n"
    : "";
  const snippetBlock = input.snippet && input.path
    ? `**What changed:** one line added to \`${input.path}\`, just before \`</body>\`:

\`\`\`${isNextScript ? "tsx" : "html"}
${input.snippet}
\`\`\`${importNote}`
    : `**What changed:** the tracker snippet was already present in \`${input.path ?? "the selected template"}\`, so this PR only updates CSP.`;
  const cspBlock = input.cspPaths.length
    ? `\n\n**CSP:** allows \`${TRACKER_ORIGIN}\` in ${input.cspPaths
        .map((path) => `\`${path}\``)
        .join(", ")} so the browser can load \`/stats.js\` and send events to \`/api/track\`.`
    : "";
  return `This PR adds the [CrawlProof](https://crawlproof.com) stats tracker to your site.

**What it does:** counts pageviews by source — AI engine referrals (ChatGPT, Perplexity, Claude, Gemini…) and AI crawler hits (GPTBot, ClaudeBot, PerplexityBot…). No cookies. No PII. Rolls up to a daily counter on the CrawlProof Stats tab for your project.

${snippetBlock}${cspBlock}

**Docs:** ${env.siteUrl}/docs/stats-tracker
**Disable:** flip the tracker off on your CrawlProof project Stats tab and the script becomes a no-op (or remove this line).`;
}
