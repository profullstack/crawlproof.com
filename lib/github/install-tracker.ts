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
  listRepoTree,
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
  replacedExistingTracker?: boolean;
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
  /*
   * Server-rendered JSX that is not Next.
   *
   * Hono, Elysia and friends render the whole document from an ordinary
   * component, conventionally a single shell called Layout. There is no
   * framework convention pointing at it, so nothing above finds it and the
   * dashboard reports a repo with a perfectly good <body> as having no target
   * file at all.
   *
   * The code-search fallback does not rescue this either: GitHub's search API
   * does not index private repositories, which is exactly what these are.
   */
  "src/views/Layout.jsx",
  "src/views/Layout.tsx",
  "src/views/layout.jsx",
  "app/views/Layout.jsx",
  // Next.js layouts are not always TypeScript.
  "app/layout.js",
  "src/app/layout.js",
  "pages/_document.js",
  "src/pages/_document.js",
  // Remix / React Router: the document shell is the root route.
  "app/root.tsx",
  "app/root.jsx",
  // SvelteKit renders every page into one HTML shell.
  "src/app.html",
  // Nuxt, when a project overrides the generated document.
  "app.html",
  // Astro, beyond the two names already probed above.
  "src/layouts/Base.astro",
  "src/layouts/MainLayout.astro",
  "src/layouts/main.astro",
  // Hugo without the _default indirection.
  "layouts/baseof.html",
  // Eleventy.
  "_includes/base.njk",
  "_includes/layout.njk",
  "src/_includes/base.njk",
  "src/_includes/layout.njk",
  // Rails.
  "app/views/layouts/application.html.erb",
  // Django / Flask / anything Jinja.
  "templates/base.html",
  // Laravel Blade.
  "resources/views/layouts/app.blade.php",
  // A WordPress theme closes the document in footer.php.
  "footer.php",
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
  // Static-HTML sites under apps/web (no framework — e.g. a hand-written
  // public/index.html served by a static host). The code-search fallback
  // is flaky for freshly-pushed repos, so probe these explicitly.
  "apps/web/index.html",
  "apps/web/public/index.html",
  "apps/web/src/index.html",
  // The same non-Next JSX shell, one workspace down. This is where both
  // tipoffwatch.com and genrewatch.com actually keep theirs.
  "apps/web/src/views/Layout.jsx",
  "apps/web/src/views/Layout.tsx",
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
 * Loose duplicate guard: does this file reference our stats.js at all?
 * The line-based regex below only matches single-line tags, so a
 * prettier-formatted multi-line <Script ... /> slips past it and we'd
 * inject a second copy. Any reference to the tracker origin's /stats.js
 * means "already installed" for injection purposes.
 */
export function hasTrackerReference(content: string): boolean {
  return content.includes(`${TRACKER_ORIGIN}/stats.js`);
}

function trackerTagLineRe() {
  const origin = escapeRegExp(TRACKER_ORIGIN);
  return new RegExp(
    `[ \\t]*(?:(?:<Script\\b(?=[^\\n>]*\\bdata-site=["'][^"']+["'])(?=[^\\n>]*\\bsrc=["']${origin}/stats\\.js["'])[^\\n>]*\\/>)|(?:<script\\b(?=[^\\n>]*\\bdata-site=["'][^"']+["'])(?=[^\\n>]*\\bsrc=["']${origin}/stats\\.js["'])[^\\n>]*>\\s*<\\/script>))[ \\t]*(?:\\r?\\n)?`,
    "gi",
  );
}

function normalizeExistingTrackerSnippets(
  content: string,
  snippet: string,
  projectId: string,
  path: string,
): { updated: string | null; path: string; replacedExistingTracker: boolean } | null {
  const re = trackerTagLineRe();
  const matches = [...content.matchAll(re)];
  if (matches.length === 0) return null;

  const projectMarkerRe = new RegExp(
    `\\bdata-site=["']${escapeRegExp(projectId)}["']`,
  );
  const hasCurrent = matches.some((match) => projectMarkerRe.test(match[0]));
  if (hasCurrent && matches.length === 1) {
    return { updated: null, path, replacedExistingTracker: false };
  }

  let kept = false;
  let updated = content.replace(re, (match) => {
    if (kept) return "";
    kept = true;
    const indent = match.match(/^[ \t]*/)?.[0] ?? "";
    const newline = match.match(/\r?\n$/)?.[0] ?? "";
    return `${indent}${snippet}${newline}`;
  });

  if (/\.(tsx|jsx)$/.test(path) && /<Script\b/.test(snippet)) {
    if (!/from\s+["']next\/script["']/.test(updated)) {
      updated = addNextScriptImport(updated);
    }
  }

  return { updated, path, replacedExistingTracker: true };
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
  // `templates/` is deliberately absent: for Django, Flask, Jinja and Rails
  // that directory is exactly where the document shell lives, and penalizing
  // it hid the only installable file in those repos.
  if (/(^|\/)(boilerplates?|examples?|samples?|fixtures?|__tests__|tests?|spec|stories|playground|sandbox|demo|node_modules)(\/|$)/i.test(path)) {
    score -= 100;
  }
  // Build output and vendored copies are never the site's own template, and a
  // tree scan surfaces plenty of both.
  if (SKIP_DIR_RE.test(path)) score -= 100;
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
  // A views/Layout shell is as canonical for a Hono app as app/layout is for
  // Next, and it sits deeper, so it needs the same nudge not to lose on length.
  if (/\/views\/layout\.(tsx|jsx)$/i.test(path)) score += 10;
  // The same nudge for the other frameworks' one true shell, each of which
  // sits deep enough to lose to noise on path length alone.
  if (/(^|\/)src\/app\.html$/i.test(path)) score += 15; // SvelteKit
  if (/(^|\/)app\/root\.(tsx|jsx)$/i.test(path)) score += 10; // Remix
  if (/(^|\/)baseof\.html$/i.test(path)) score += 10; // Hugo
  if (/(^|\/)footer\.php$/i.test(path)) score += 5; // WordPress theme
  // Whatever the framework, a file under a templates dir is a better guess
  // than a component that merely happens to be named the same.
  if (TEMPLATE_DIR_RE.test(path)) score += 5;
  // Shorter paths slightly preferred (closer to root = more canonical).
  score -= path.length * 0.05;
  return score;
}

// Scanning the tree means fetching files to see whether they close a document,
// so the filter below decides what is worth a request.

// Extensions that are essentially always a page or document template.
const DOCUMENT_EXT_RE =
  /\.(x?html?|astro|ejs|hbs|handlebars|liquid|njk|nunjucks|twig|erb|mustache|eta|gohtml|tmpl|cshtml|razor|edge)$/i;

// Extensions that are usually a component rather than a document. One of these
// only earns a request when its name or its directory says "document shell".
const COMPONENT_EXT_RE = /\.([cm]?[jt]sx?|vue|svelte|php)$/i;

// The names a document shell goes by, across frameworks. Matched against the
// first dot-segment, so application.html.erb and _document.tsx both work.
const SHELL_NAME_RE =
  /^(_?document|_?app|layout|root|base|baseof|default|shell|template|footer|head|html|entry-server)$/i;

// Directories that hold templates whatever the stack.
const TEMPLATE_DIR_RE =
  /(^|\/)(layouts?|views?|templates?|_layouts|_includes|partials|themes?)(\/|$)/i;

// Never worth a request: build output, vendored code, test fixtures.
const SKIP_DIR_RE =
  /(^|\/)(node_modules|\.git|\.next|\.nuxt|\.svelte-kit|\.astro|\.cache|\.vercel|dist|build|out|coverage|vendor|third_party|storybook-static|\.storybook|__snapshots__|__fixtures__|__mocks__)(\/|$)/i;

/** How many tree-discovered files we will open looking for a </body>. */
const MAX_TREE_PROBES = 30;

/** Parallel GETs against the contents API. Polite, and well under the limit. */
const PROBE_CONCURRENCY = 6;

/**
 * Template-shaped paths from a repo tree, best-first and capped.
 *
 * The canonical list only knows the conventions someone thought to write
 * down. A repo that keeps its shell somewhere else — or uses a framework
 * nobody here has met — still has a file that closes the document, and the
 * tree names every path in the repo for one request.
 */
function templateShapedPaths(
  files: string[],
  root: string,
  repoName: string,
): string[] {
  const prefix = root ? `${root}/` : "";
  return files
    .filter((p) => (prefix ? p.startsWith(prefix) : true))
    .filter((p) => !SKIP_DIR_RE.test(p))
    .filter((p) => {
      const name = p.slice(p.lastIndexOf("/") + 1);
      if (DOCUMENT_EXT_RE.test(name)) return true;
      if (!COMPONENT_EXT_RE.test(name)) return false;
      return SHELL_NAME_RE.test(name.split(".")[0]) || TEMPLATE_DIR_RE.test(p);
    })
    .sort((a, b) => rankCandidatePath(b, repoName) - rankCandidatePath(a, repoName))
    .slice(0, MAX_TREE_PROBES);
}

/** Run an async map over items, at most `limit` in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
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

  // One request lists every path in the repo, which answers two questions the
  // canonical probes can't: which of those paths actually exist (so we skip
  // the misses), and where a repo that follows none of our conventions keeps
  // its shell. Unlike code search this works on private repos, which is most
  // of them.
  let tree: Awaited<ReturnType<typeof listRepoTree>> = null;
  try {
    tree = await listRepoTree({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      ref,
    });
  } catch {
    // The tree is an optimization on top of a fallback; losing it only costs
    // us the probes we were making before.
  }

  let probes: string[];
  if (tree) {
    const present = new Set(tree.files);
    probes = [
      // A truncated tree is only a prefix of the repo, so absence from it
      // proves nothing — keep probing the whole canonical list.
      ...(tree.truncated ? canonical : canonical.filter((p) => present.has(p))),
      ...templateShapedPaths(tree.files, root, input.repo),
    ];
  } else {
    probes = canonical;
  }

  const found = new Map<string, { sizeBytes?: number }>();

  // Open each candidate and keep the ones that actually close a document.
  const files = await mapWithConcurrency(
    [...new Set(probes)],
    PROBE_CONCURRENCY,
    (path) =>
      getFileContent({
        token: input.token,
        owner: input.owner,
        repo: input.repo,
        path,
        ref,
      }),
  );
  for (const file of files) {
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
        replacedExistingTracker: boolean;
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
  const snippet = snippetForPath(input.projectId, file.path);
  const normalized = normalizeExistingTrackerSnippets(
    file.content,
    snippet,
    input.projectId,
    file.path,
  );
  if (normalized?.updated) {
    return {
      status: "ready",
      path: file.path,
      snippet,
      before: file.content,
      after: normalized.updated,
      addsImport:
        /\.(tsx|jsx)$/.test(file.path) &&
        /<Script\b/.test(snippet) &&
        !/from\s+["']next\/script["']/.test(file.content),
      replacedExistingTracker: true,
    };
  }
  if (normalized) {
    return { status: "already_installed", path: file.path };
  }
  // Multi-line or unusually formatted tags won't match the line regex but
  // are still an install — never inject a duplicate next to one.
  if (hasTrackerReference(file.content)) {
    return { status: "already_installed", path: file.path };
  }
  if (!/<\/body>/i.test(file.content)) {
    return {
      status: "not_a_template",
      path: file.path,
      reason: "No </body> tag in this file.",
    };
  }
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
    replacedExistingTracker: false,
  };
}

export function addSourceToDirective(content: string, directive: string, source: string) {
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

export function hasDirective(content: string, directive: string) {
  return new RegExp(`${directive}\\b`, "i").test(content);
}

export function looksLikeCsp(content: string) {
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

// Scans the repo for CSP config files and returns the ones that `patch`
// rewrites (append-only). Reused by both the tracker and ad installers — the
// only difference is which origins/directives `patch` touches.
export async function findCspPatchTargets(input: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
  root: string;
  patch: (content: string) => string | null;
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
    const updated = input.patch(file.content);
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

  const root = normalizeRoot(input.rootPath);
  const candidates = candidatePaths(root);

  // Probe a path: returns the file if it has </body> AND doesn't already
  // have our snippet; signals "already installed" if it does.
  type ProbeResult =
    | {
        kind: "hit";
        file: {
          path: string;
          sha: string;
          content: string;
          updated?: string;
          replacedExistingTracker?: boolean;
        };
      }
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
    const snippet = snippetForPath(input.projectId, file.path);
    const normalized = normalizeExistingTrackerSnippets(
      file.content,
      snippet,
      input.projectId,
      file.path,
    );
    if (normalized?.updated) {
      return {
        kind: "hit",
        file: {
          ...file,
          updated: normalized.updated,
          replacedExistingTracker: true,
        },
      };
    }
    if (normalized) {
      return { kind: "already", path: file.path };
    }
    // Same guard as previewInstallAtPath: a multi-line tag the line regex
    // can't parse still counts as installed.
    if (hasTrackerReference(file.content)) {
      return { kind: "already", path: file.path };
    }
    if (/<\/body>/i.test(file.content)) {
      return { kind: "hit", file };
    }
    return { kind: "miss" };
  };

  let target: {
    path: string;
    sha: string;
    content: string;
    updated?: string;
    replacedExistingTracker?: boolean;
  } | null = null;
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

  // 2. Fallback: read the repo tree and probe anything template-shaped. The
  //    canonical list above is a list of conventions, and a repo is free to
  //    keep its shell somewhere none of them predict. This runs before code
  //    search because it works on private repos, which search does not index.
  if (!target && !alreadyInstalledPath) {
    let tree: Awaited<ReturnType<typeof listRepoTree>> = null;
    try {
      tree = await listRepoTree({
        token: input.token,
        owner: input.owner,
        repo: input.repo,
        ref: base,
      });
    } catch {
      // Non-fatal: code search below is still there to try.
    }
    if (tree) {
      const seen = new Set(candidates);
      for (const path of templateShapedPaths(tree.files, root, input.repo)) {
        if (seen.has(path)) continue;
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
    }
  }

  // 3. Fallback: ask GitHub's code search for any file containing </body>
  //    in this repo. Handles monorepos (e.g. apps/web/app/layout.tsx,
  //    sites/foo/app/layout.tsx) and non-standard frameworks
  //    (SvelteKit src/app.html, Remix app/root.tsx, ...).
  if (!target && !alreadyInstalledPath) {
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
    const hint = root
      ? `Looked under root "${root}". Try a different root path, or name the file to install into.`
      : "Monorepo? Set a root path on the project's Repos tab to point at the app directory (e.g. apps/web). Otherwise name the file to install into.";
    throw new Error(
      `No template file with </body> found in ${input.owner}/${input.repo} on ${base}. ` +
        `Searched the canonical layout paths, every template-shaped file in the repo, and code search. ${hint}`,
    );
  }

  // Compute the new content. Snippet shape (Next.js <Script> vs raw
  // <script>) depends on the target file extension.
  const snippet = target ? snippetForPath(input.projectId, target.path) : null;
  const updated = target?.updated
    ? target.updated
    : target
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
    patch: patchCspForTracker,
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
    replacedExistingTracker: !!target?.replacedExistingTracker,
    detail: target
      ? target.replacedExistingTracker
        ? `Replaced existing CrawlProof tracker snippet in ${target.path}.${cspDetail}`
        : `Inserted snippet before </body> in ${target.path}.${cspDetail}`
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
