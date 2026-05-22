// Apply a CrawlProof audit fix as a GitHub pull request. Loads relevant
// repo files, asks Claude to produce a patched version that addresses
// the specific check, commits the changes on a branch, opens a PR.
//
// Credit accounting: callers consume 1 credit BEFORE invoking this and
// refund on any failure. The implementation here is purely the GitHub +
// LLM dance; billing lives in the API route.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import {
  createBranch,
  getFileContent,
  getRepo,
  openPullRequest,
  putFile,
  type FileContent,
} from "./repos";

interface FindingInput {
  check_key: string;
  title: string;
  detail: string | null;
  section: string;
  priority: number;
  evidence: unknown;
}

interface ApplyFixInput {
  token: string;
  owner: string;
  repo: string;
  finding: FindingInput;
  targetUrl: string;
}

export interface ApplyFixResult {
  status: "opened" | "noop";
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  changedPaths?: string[];
  detail: string;
}

// Heuristic candidate files per finding family. We probe these on the
// repo's default branch; missing files are silently skipped. Claude
// receives only the files we successfully fetch.
const CANDIDATES_BY_PREFIX: Record<string, string[]> = {
  "robots.": [
    "public/robots.txt",
    "static/robots.txt",
    "robots.txt",
    "app/robots.txt",
    "app/robots.ts",
  ],
  "llms.": [
    "public/llms.txt",
    "static/llms.txt",
    "llms.txt",
    "app/llms.txt",
    "app/llms.txt/route.ts",
  ],
  "schema.": [
    "app/layout.tsx",
    "app/layout.jsx",
    "src/app/layout.tsx",
    "pages/_document.tsx",
    "pages/_document.jsx",
    "src/layouts/Layout.astro",
    "index.html",
    "public/index.html",
  ],
  "meta.": [
    "app/layout.tsx",
    "app/layout.jsx",
    "src/app/layout.tsx",
    "pages/_document.tsx",
    "src/layouts/Layout.astro",
    "index.html",
    "public/index.html",
  ],
  "positioning.": [
    "app/page.tsx",
    "app/page.jsx",
    "src/app/page.tsx",
    "pages/index.tsx",
    "pages/index.jsx",
    "src/pages/index.astro",
    "index.html",
    "public/index.html",
  ],
  "sitemap.": [
    "public/sitemap.xml",
    "static/sitemap.xml",
    "app/sitemap.ts",
    "app/sitemap.xml",
  ],
};

const FALLBACK_CANDIDATES = [
  "app/layout.tsx",
  "app/layout.jsx",
  "src/app/layout.tsx",
  "pages/_document.tsx",
  "src/layouts/Layout.astro",
  "index.html",
  "public/index.html",
];

function candidatesFor(checkKey: string): string[] {
  for (const prefix of Object.keys(CANDIDATES_BY_PREFIX)) {
    if (checkKey.startsWith(prefix)) return CANDIDATES_BY_PREFIX[prefix];
  }
  return FALLBACK_CANDIDATES;
}

async function loadCandidateFiles(input: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
  paths: string[];
}): Promise<FileContent[]> {
  const found: FileContent[] = [];
  for (const path of input.paths) {
    const f = await getFileContent({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path,
      ref: input.ref,
    });
    if (f) found.push(f);
  }
  return found;
}

const MAX_FILE_BYTES = 50_000; // Truncate huge files; Claude's window has limits.

function truncate(s: string): string {
  if (s.length <= MAX_FILE_BYTES) return s;
  return s.slice(0, MAX_FILE_BYTES) + "\n\n[…truncated for brevity…]";
}

interface ClaudePatchResponse {
  files: { path: string; content: string }[];
  explanation: string;
}

async function askClaude(input: {
  finding: FindingInput;
  files: FileContent[];
  targetUrl: string;
  owner: string;
  repo: string;
}): Promise<ClaudePatchResponse> {
  if (!env.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured.");
  }
  const client = new Anthropic({ apiKey: env.anthropicApiKey });

  const fileBlocks = input.files
    .map(
      (f) =>
        `<file path="${f.path}">\n${truncate(f.content)}\n</file>`,
    )
    .join("\n\n");

  const systemPrompt = `You are CrawlProof's automated fixer for AEO (Answer Engine Optimization) audits. The user has approved one specific finding to be fixed via a pull request against their repository ${input.owner}/${input.repo}.

You return a JSON object with the EXACT shape:
{
  "files": [{ "path": string, "content": string }],
  "explanation": string
}

Rules:
- ONLY include files you are actually changing. Do NOT echo unchanged files.
- The "content" is the FULL new file content (not a diff). Preserve everything you don't intend to change byte-for-byte.
- Prefer a minimal, surgical change. The PR should be reviewable in under a minute.
- If you cannot fix the finding from the files provided, return { "files": [], "explanation": "..." } describing what's missing.
- Do not invent files. Only edit files that exist in the input, or create a file that's clearly canonical for the framework (e.g., public/robots.txt for a robots fix, app/llms.txt/route.ts for a Next.js llms.txt).
- Match the project's existing style (quotes, indentation, framework conventions).
- Output ONLY the JSON object, no markdown fences, no commentary.`;

  const userPrompt = `Target site: ${input.targetUrl}
Audit finding to fix:
- Check key: ${input.finding.check_key}
- Section: ${input.finding.section}
- Priority: ${input.finding.priority}
- Title: ${input.finding.title}
- Detail: ${input.finding.detail ?? "(none)"}
- Evidence: ${JSON.stringify(input.finding.evidence)}

Relevant repository files (default branch):

${fileBlocks || "(no candidate files found in repo — propose a new file to address the finding)"}

Return the JSON object now.`;

  const res = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  // Concatenate all text blocks. The model is instructed to return JSON
  // only; if it slips in prose we still try to find the JSON.
  const textParts = res.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("");
  const jsonStart = textParts.indexOf("{");
  const jsonEnd = textParts.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < 0) {
    throw new Error(`Claude response missing JSON: ${textParts.slice(0, 200)}`);
  }
  const raw = textParts.slice(jsonStart, jsonEnd + 1);
  const parsed = JSON.parse(raw) as ClaudePatchResponse;
  if (!Array.isArray(parsed.files)) {
    throw new Error("Claude response missing 'files' array");
  }
  return parsed;
}

const BRANCH_PREFIX = "crawlproof/fix";

export async function applyFix(input: ApplyFixInput): Promise<ApplyFixResult> {
  const repoMeta = await getRepo({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
  });
  const base = repoMeta.default_branch;

  const candidates = candidatesFor(input.finding.check_key);
  const files = await loadCandidateFiles({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    ref: base,
    paths: candidates,
  });

  const patch = await askClaude({
    finding: input.finding,
    files,
    targetUrl: input.targetUrl,
    owner: input.owner,
    repo: input.repo,
  });

  if (patch.files.length === 0) {
    return {
      status: "noop",
      detail:
        patch.explanation ||
        "Claude found nothing to change with the files available.",
    };
  }

  // Index existing file shas so updates carry the sha; creates leave it.
  const shaByPath = new Map(files.map((f) => [f.path, f.sha]));

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeKey = input.finding.check_key.replace(/[^a-z0-9.]/gi, "-");
  const branch = `${BRANCH_PREFIX}/${safeKey}-${ts}`;
  await createBranch({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    newBranch: branch,
    fromBranch: base,
  });

  const changed: string[] = [];
  for (const f of patch.files) {
    await putFile({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path: f.path,
      branch,
      message: `Fix ${input.finding.check_key}: ${input.finding.title}`,
      contentUtf8: f.content,
      sha: shaByPath.get(f.path),
    });
    changed.push(f.path);
  }

  const pr = await openPullRequest({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    head: branch,
    base,
    title: `CrawlProof fix: ${input.finding.title}`,
    body: prBody(input.finding, patch.explanation, changed),
  });

  return {
    status: "opened",
    prUrl: pr.html_url,
    prNumber: pr.number,
    branch,
    changedPaths: changed,
    detail: `Opened PR with ${changed.length} file change(s).`,
  };
}

function prBody(
  finding: FindingInput,
  explanation: string,
  changed: string[],
): string {
  return `**CrawlProof automated fix** for the following audit finding:

> **${finding.title}**
> ${finding.detail ?? ""}

**Check:** \`${finding.check_key}\` (priority ${finding.priority})

**What changed:**
${changed.map((p) => `- \`${p}\``).join("\n")}

**Why:**
${explanation}

---

Generated by Claude Sonnet 4.6. Review the diff before merging — automated edits are not infallible. Disagree with the change? Close the PR and apply the fix manually using the audit recommendations on your CrawlProof project page.

Docs: ${env.siteUrl}/docs/aeo-score`;
}
