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
} from "./repos";

interface InstallInput {
  token: string;
  owner: string;
  repo: string;
  projectId: string;
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

function snippetFor(projectId: string): string {
  return `<script data-site="${projectId}" src="${env.siteUrl.replace(/\/$/, "")}/stats.js" async></script>`;
}

/**
 * Return content with the snippet inserted before the first </body>, or
 * null if there's no </body> in the file.
 */
function injectBeforeBodyClose(
  content: string,
  snippet: string,
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
  return `${prefix}${indent}  ${snippet}\n${indent}${content.slice(idx)}`;
}

export async function installTracker(input: InstallInput): Promise<InstallResult> {
  const repoMeta = await getRepo({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
  });
  const base = repoMeta.default_branch;
  const snippet = snippetFor(input.projectId);
  const projectIdMarker = `data-site="${input.projectId}"`;

  // 1. Find a candidate file that contains </body>.
  let target: { path: string; sha: string; content: string } | null = null;
  for (const path of CANDIDATES) {
    const file = await getFileContent({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path,
      ref: base,
    });
    if (!file) continue;
    if (file.content.includes(projectIdMarker)) {
      return {
        status: "noop",
        path: file.path,
        detail: `Tracker already installed at ${file.path}.`,
      };
    }
    if (/<\/body>/i.test(file.content)) {
      target = file;
      break;
    }
  }

  if (!target) {
    throw new Error(
      `No template file with </body> found. Looked in: ${CANDIDATES.join(", ")}.`,
    );
  }

  // 2. Compute the new content.
  const updated = injectBeforeBodyClose(target.content, snippet);
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
    body: prBody(input.projectId, target.path),
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

function prBody(projectId: string, path: string): string {
  return `This PR adds the [CrawlProof](https://crawlproof.com) stats tracker to your site.

**What it does:** counts pageviews by source — AI engine referrals (ChatGPT, Perplexity, Claude, Gemini…) and AI crawler hits (GPTBot, ClaudeBot, PerplexityBot…). No cookies. No PII. Rolls up to a daily counter on the CrawlProof Stats tab for your project.

**What changed:** one line added to \`${path}\`, just before \`</body>\`:

\`\`\`html
<script data-site="${projectId}" src="${env.siteUrl}/stats.js" async></script>
\`\`\`

**Docs:** ${env.siteUrl}/docs/stats-tracker
**Disable:** flip the tracker off on your CrawlProof project Stats tab and the script becomes a no-op (or remove this line).`;
}
