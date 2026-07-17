// Install the CrawlProof ad unit into a publisher's repo as a pull request.
// Mirrors install-tracker.ts (deterministic, no LLM) but injects the /ad.js
// embed for a given slot. Reuses findInstallCandidates (snippet-agnostic —
// it just locates files containing </body>) and the low-level repo helpers.

import { env } from "@/lib/env";
import {
  createBranch,
  getFileContent,
  getRepo,
  openPullRequest,
  putFile,
} from "./repos";
import {
  addSourceToDirective,
  findCspPatchTargets,
  findInstallCandidates,
  hasDirective,
  looksLikeCsp,
} from "./install-tracker";

const AD_ORIGIN = env.siteUrl.replace(/\/$/, "");
const BRANCH_PREFIX = "crawlproof/install-ad-embed";

// Append CrawlProof's origin to the CSP directives the ad unit needs, so the
// embed isn't silently blocked on sites that ship a Content-Security-Policy.
// The unit (1) loads /ad.js (script-src), (2) fetches /api/ads/serve
// (connect-src), and (3) renders the creative — including its images — inside
// a same-origin srcdoc iframe that inherits the host page's CSP (img-src for
// the artwork; frame-src/child-src must allow 'self' for the srcdoc frame).
// Append-only and conservative: only rewrites files that already look like a
// CSP, and never adds a directive that wasn't there.
export function patchCspForAds(content: string): string | null {
  if (!looksLikeCsp(content)) return null;
  let updated = content;

  const addOrigin = (directive: string, fallback = "default-src") => {
    if (hasDirective(updated, directive)) {
      updated = addSourceToDirective(updated, directive, AD_ORIGIN);
    } else if (fallback && hasDirective(updated, fallback)) {
      updated = addSourceToDirective(updated, fallback, AD_ORIGIN);
    }
  };

  addOrigin("script-src"); // load /ad.js
  if (hasDirective(updated, "script-src-elem")) {
    updated = addSourceToDirective(updated, "script-src-elem", AD_ORIGIN);
  }
  addOrigin("connect-src"); // fetch /api/ads/serve
  addOrigin("img-src"); // creative + house artwork inside the srcdoc iframe

  // The ad is a same-origin srcdoc iframe: a restrictive frame-src/child-src
  // must allow 'self'. There's no origin to add — srcdoc frames take the host's
  // origin — so we only widen these directives when they already exist.
  if (hasDirective(updated, "frame-src")) {
    updated = addSourceToDirective(updated, "frame-src", "'self'");
  }
  if (hasDirective(updated, "child-src")) {
    updated = addSourceToDirective(updated, "child-src", "'self'");
  }

  return updated === content ? null : updated;
}

export interface InstallAdInput {
  token: string;
  owner: string;
  repo: string;
  slotId: string;
  format?: string;
  rootPath?: string;
  /** Explicit target file; skips discovery when set. */
  targetPath?: string;
}

export interface InstallAdResult {
  status: "opened" | "noop";
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  path?: string;
  /** CSP config files patched so the ad unit isn't blocked. */
  cspPaths?: string[];
  detail: string;
}

const DEFAULT_FORMAT = "banner_300x250";

function rawEmbed(slotId: string, format: string): string {
  return `<div data-cp-ad data-slot="${slotId}" data-format="${format}"></div>\n    <script src="${AD_ORIGIN}/ad.js" async></script>`;
}

// JSX/TSX layouts: a self-closing div + next/script <Script>. React renders
// the valueless data attribute as data-cp-ad="true"; the [data-cp-ad] selector
// still matches.
function nextEmbed(slotId: string, format: string): string {
  return `<div data-cp-ad="" data-slot="${slotId}" data-format="${format}" />\n      <Script src="${AD_ORIGIN}/ad.js" strategy="afterInteractive" />`;
}

function isJsx(path: string): boolean {
  return /\.(tsx|jsx)$/.test(path);
}

function embedForPath(slotId: string, format: string, path: string): string {
  return isJsx(path) ? nextEmbed(slotId, format) : rawEmbed(slotId, format);
}

// Already installed if this slot's embed OR our /ad.js is present.
function hasAdReference(content: string, slotId: string): boolean {
  return content.includes(`${AD_ORIGIN}/ad.js`) || content.includes(`data-slot="${slotId}"`);
}

function addNextScriptImport(content: string): string {
  const importLine = `import Script from "next/script";`;
  const lines = content.split("\n");
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) if (/^import\b/.test(lines[i])) lastImport = i;
  if (lastImport === -1) return `${importLine}\n${content}`;
  lines.splice(lastImport + 1, 0, importLine);
  return lines.join("\n");
}

function injectBeforeBodyClose(content: string, embed: string, path: string): string | null {
  const match = content.match(/<\/body>/i);
  if (!match || match.index == null) return null;
  const idx = match.index;
  const prefix = content.slice(0, idx);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  const indent = prefix.slice(lineStart).match(/^\s*/)?.[0] ?? "";
  let updated = `${prefix}${indent}  ${embed}\n${indent}${content.slice(idx)}`;
  if (isJsx(path) && /<Script\b/.test(embed) && !/from\s+["']next\/script["']/.test(updated)) {
    updated = addNextScriptImport(updated);
  }
  return updated;
}

// Inject right after the opening <body …> tag — the "right place" for a
// leaderboard, which reads best across the top of the page rather than jammed
// at the very bottom before </body>. Best-effort: callers fall back to
// injectBeforeBodyClose when there's no <body> tag (e.g. a React fragment).
function injectAfterBodyOpen(content: string, embed: string, path: string): string | null {
  const match = content.match(/<body\b[^>]*>/i);
  if (!match || match.index == null) return null;
  const openEnd = match.index + match[0].length;
  const lineStart = content.lastIndexOf("\n", match.index) + 1;
  const indent = content.slice(lineStart, match.index).match(/^\s*/)?.[0] ?? "";
  let updated = `${content.slice(0, openEnd)}\n${indent}  ${embed}${content.slice(openEnd)}`;
  if (isJsx(path) && /<Script\b/.test(embed) && !/from\s+["']next\/script["']/.test(updated)) {
    updated = addNextScriptImport(updated);
  }
  return updated;
}

// Sizes that want to sit at the top of the page instead of before </body>.
const TOP_PLACED_FORMATS = new Set<string>(["banner_728x90"]);

// Choose where a format's embed lands. Leaderboards go up top; everything else
// (rectangle, mobile, text link) drops in before </body>. Always falls back to
// the other strategy so a missing <body>/<body …> never blocks the install.
function injectEmbed(content: string, embed: string, path: string, format: string): string | null {
  if (TOP_PLACED_FORMATS.has(format)) {
    return injectAfterBodyOpen(content, embed, path) ?? injectBeforeBodyClose(content, embed, path);
  }
  return injectBeforeBodyClose(content, embed, path);
}

export async function installAdEmbed(input: InstallAdInput): Promise<InstallAdResult> {
  const format = input.format ?? DEFAULT_FORMAT;
  const repoMeta = await getRepo({ token: input.token, owner: input.owner, repo: input.repo });
  const base = repoMeta.default_branch;

  // Pick a target file: explicit, else the top-ranked </body> candidate.
  let targetPath = input.targetPath;
  if (!targetPath) {
    const candidates = await findInstallCandidates({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      rootPath: input.rootPath,
    });
    targetPath = candidates[0]?.path;
  }
  if (!targetPath) {
    return { status: "noop", detail: "No layout/template file with a </body> tag was found in the repo." };
  }

  const file = await getFileContent({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    path: targetPath,
    ref: base,
  });
  if (!file) {
    return { status: "noop", path: targetPath, detail: `File not found: ${targetPath}` };
  }

  // Layout may already carry the embed (e.g. a re-run, or the publisher pasted
  // it by hand). We still open a PR when there's a CSP file to patch.
  const alreadyInstalled = hasAdReference(file.content, input.slotId);
  const embed = embedForPath(input.slotId, format, file.path);
  const updated = alreadyInstalled
    ? null
    : injectEmbed(file.content, embed, file.path, format);
  if (!alreadyInstalled && !updated) {
    return { status: "noop", path: file.path, detail: `No <body> tag in ${file.path}.` };
  }

  // Patch the site's CSP so the browser can load /ad.js, reach /api/ads/serve,
  // and render the creative iframe — mirrors the stats-tracker installer.
  const root = (input.rootPath ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  const cspPatches = await findCspPatchTargets({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    ref: base,
    root,
    patch: patchCspForAds,
  });

  // Nothing to do: embed present and no CSP needs widening.
  if (alreadyInstalled && cspPatches.length === 0) {
    return {
      status: "noop",
      path: file.path,
      detail: `Ad embed already present in ${file.path}; no CSP changes needed.`,
    };
  }

  const branch = `${BRANCH_PREFIX}-${input.slotId.slice(0, 8)}-${Date.now().toString(36)}`;
  await createBranch({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    newBranch: branch,
    fromBranch: base,
  });
  if (updated) {
    await putFile({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path: file.path,
      branch,
      message: "Add CrawlProof ad unit",
      contentUtf8: updated,
      sha: file.sha,
    });
  }
  for (const patch of cspPatches) {
    await putFile({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path: patch.path,
      branch,
      message: "Allow CrawlProof ads in CSP",
      contentUtf8: patch.updated,
      sha: patch.sha,
    });
  }

  const cspPaths = cspPatches.map((p) => p.path);
  const cspBody = cspPaths.length
    ? `\n- Allowed \`${AD_ORIGIN}\` in your CSP (${cspPaths
        .map((p) => `\`${p}\``)
        .join(", ")}) so the ad unit isn't blocked.`
    : "";
  const pr = await openPullRequest({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    head: branch,
    base,
    title: updated ? "Add CrawlProof ad unit" : "Allow CrawlProof ads in CSP",
    body: [
      "This PR adds the CrawlProof ad unit so this site can show network ads and earn crypto for clicks.",
      "",
      `- Slot: \`${input.slotId}\``,
      `- Format: \`${format}\``,
      updated
        ? `- Injected into \`${file.path}\` before \`</body>\`.`
        : `- Ad embed already present in \`${file.path}\`.`,
      cspBody,
      "",
      "The unit renders inside a sandboxed iframe and never blocks page load. Manage the slot at " +
        `${AD_ORIGIN}/ads/slots`,
    ].join("\n"),
  });

  const cspDetail = cspPaths.length ? ` Patched CSP in ${cspPaths.join(", ")}.` : "";
  return {
    status: "opened",
    prUrl: pr.html_url,
    prNumber: pr.number,
    branch,
    path: file.path,
    cspPaths,
    detail: updated
      ? `Opened PR #${pr.number} injecting the ad unit into ${file.path}.${cspDetail}`
      : `Opened PR #${pr.number} to allow CrawlProof ads in your CSP.${cspDetail}`,
  };
}
