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
import { findInstallCandidates } from "./install-tracker";

const AD_ORIGIN = env.siteUrl.replace(/\/$/, "");
const BRANCH_PREFIX = "crawlproof/install-ad-embed";

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

  if (hasAdReference(file.content, input.slotId)) {
    return { status: "noop", path: file.path, detail: `Ad embed already present in ${file.path}.` };
  }

  const embed = embedForPath(input.slotId, format, file.path);
  const updated = injectBeforeBodyClose(file.content, embed, file.path);
  if (!updated) {
    return { status: "noop", path: file.path, detail: `No </body> tag in ${file.path}.` };
  }

  const branch = `${BRANCH_PREFIX}-${input.slotId.slice(0, 8)}-${Date.now().toString(36)}`;
  await createBranch({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    newBranch: branch,
    fromBranch: base,
  });
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
  const pr = await openPullRequest({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    head: branch,
    base,
    title: "Add CrawlProof ad unit",
    body: [
      "This PR adds the CrawlProof ad unit so this site can show network ads and earn crypto for clicks.",
      "",
      `- Slot: \`${input.slotId}\``,
      `- Format: \`${format}\``,
      `- Injected into \`${file.path}\` before \`</body>\`.`,
      "",
      "The unit renders inside a sandboxed iframe and never blocks page load. Manage the slot at " +
        `${AD_ORIGIN}/ads/slots`,
    ].join("\n"),
  });

  return {
    status: "opened",
    prUrl: pr.html_url,
    prNumber: pr.number,
    branch,
    path: file.path,
    detail: `Opened PR #${pr.number} injecting the ad unit into ${file.path}.`,
  };
}
