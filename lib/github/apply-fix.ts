// Apply a CrawlProof audit fix as a GitHub pull request, with Claude
// driving the change via tool use. Claude can list directories, read
// files, search code, and stage file writes; the loop runs until Claude
// calls the `done` tool or hits the iteration cap. Then we commit the
// staged writes on a branch and open the PR.
//
// Credit accounting lives in the API route; this function just runs the
// tool loop and pushes the PR.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import {
  createBranch,
  getFileContent,
  getRepo,
  listRepoDirectory,
  openPullRequest,
  putFile,
  searchRepoCode,
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
  /** Optional subdirectory hint (e.g. "apps/web") to start exploration in. */
  rootPath?: string;
  /** Optional user guidance for this PR, such as brand naming rules. */
  userPrompt?: string;
  onProgress?: (message: string) => void | Promise<void>;
}

export interface ApplyFixResult {
  status: "opened" | "noop";
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  changedPaths?: string[];
  detail: string;
}

// Hard limits keep worst-case cost bounded.
const MAX_ITERATIONS = 20;
const MAX_FILE_READ_BYTES = 50_000;
const MAX_FILE_WRITE_BYTES = 100_000;
const MAX_TOTAL_WRITE_BYTES = 200_000;
const MAX_DIR_ENTRIES = 100;

// Paths Claude shouldn't touch — keeps it focused on app code.
const BLOCKED_PATH_PATTERNS = [
  /^\./, // dotfiles / dotdirs (.git, .github, etc.)
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)\.cache(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /\.lock$/,
  /pnpm-lock\.yaml$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
];

function isPathBlocked(path: string): boolean {
  const normalized = path.replace(/^\/+/, "");
  return BLOCKED_PATH_PATTERNS.some((re) => re.test(normalized));
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_directory",
    description:
      "List the immediate children of a directory in the repository. Use an empty string for the repo root.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository path. Empty string for root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a file's contents from the default branch. Returns null if the file doesn't exist. Large files are truncated.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path to the file." },
      },
      required: ["path"],
    },
  },
  {
    name: "search_code",
    description:
      "Search the repository for files containing a literal substring. Useful for finding components, configs, or markup patterns across an unfamiliar repo.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'Literal substring to find (e.g. "</body>", "JSON-LD", "robots").',
        },
      },
      required: ["query"],
    },
  },
  {
    name: "write_file",
    description:
      "Stage a file change. Writes the full new contents (not a diff). Use the same path you read; for new files, pick a canonical location for the framework. Writes are buffered and only land if you eventually call done().",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path to write." },
        content: {
          type: "string",
          description: "Full new contents of the file.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "done",
    description:
      "Call this when the fix is complete (or you've determined the finding can't be fixed from the repo). Provide a short summary that will appear in the pull request body.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "What changed and why, in 1-3 sentences. If no fix was possible, explain why.",
        },
      },
      required: ["summary"],
    },
  },
];

function buildSystemPrompt(owner: string, repo: string): string {
  return `You are CrawlProof's automated fixer for AEO (Answer Engine Optimization) audit findings. The user has approved one specific finding to be fixed via a pull request on the repository ${owner}/${repo}.

You have these tools:
- list_directory(path) — explore the project structure.
- read_file(path) — read a file. Large files are truncated.
- search_code(query) — find files containing a literal substring across the repo.
- write_file(path, content) — STAGE a file change. Writes are buffered; nothing leaves the system until you call done(). Use the full new file contents (not a diff).
- done(summary) — signal completion.

Rules:
1. **Be surgical.** Make the minimum change that addresses the finding. Don't refactor unrelated code, restyle untouched lines, or rename variables you don't need to.
2. **Understand before you write.** Use list_directory + read_file to learn the project's structure and conventions before staging any change.
3. **Match the existing style** — quotes, indentation, framework idioms (e.g. Next.js \`<Script>\` from next/script, not raw \`<script>\`).
4. **Don't touch generated / vendored files.** Anything under .git/, node_modules/, dist/, build/, .next/, .cache/, coverage/, or any lockfile is off-limits.
5. **One coherent change.** All write_file calls become one PR. Don't open multiple parallel fixes.
6. **Always call done().** If you finish, call done with a summary. If the finding can't be fixed from this repo (e.g. it's about live HTTP headers, DNS, or third-party services), call done explaining why — that closes the loop cleanly without an empty PR.

Hard limits:
- Up to ${MAX_ITERATIONS} tool turns.
- Files larger than ${MAX_FILE_READ_BYTES} bytes are truncated when read.
- Each write must be under ${MAX_FILE_WRITE_BYTES} bytes; total writes across the run under ${MAX_TOTAL_WRITE_BYTES} bytes.`;
}

export function buildApplyFixUserPrompt(input: {
  finding: FindingInput;
  targetUrl: string;
  defaultBranch: string;
  rootPath?: string;
  userPrompt?: string;
}): string {
  return `Target site: ${input.targetUrl}
Default branch: ${input.defaultBranch}${input.rootPath ? `\nUser hint: the site code lives under \`${input.rootPath}\` — start there.` : ""}
${input.userPrompt ? `\nAdditional user guidance for this PR:\n${input.userPrompt.trim()}\n` : ""}

Audit finding to fix:
- Check key: ${input.finding.check_key}
- Section: ${input.finding.section}
- Priority: ${input.finding.priority}
- Title: ${input.finding.title}
- Detail: ${input.finding.detail ?? "(none)"}
- Evidence: ${JSON.stringify(input.finding.evidence)}

Start exploring. When ready, stage changes with write_file and call done().`;
}

interface RunState {
  writes: Map<string, string>;
  totalWriteBytes: number;
  explanation: string;
  doneReached: boolean;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[…truncated at ${max} bytes…]`;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: {
    token: string;
    owner: string;
    repo: string;
    ref: string;
    state: RunState;
  },
): Promise<string> {
  try {
    if (name === "list_directory") {
      const path = String(input.path ?? "");
      if (path && isPathBlocked(path)) {
        return `Refused: path "${path}" is blocked (generated / vendored).`;
      }
      const entries = await listRepoDirectory({
        token: ctx.token,
        owner: ctx.owner,
        repo: ctx.repo,
        path,
        ref: ctx.ref,
      });
      if (!entries) return `Not a directory (or doesn't exist): ${path || "/"}`;
      const trimmed = entries.slice(0, MAX_DIR_ENTRIES);
      const lines = trimmed.map(
        (e) => `${e.type === "dir" ? "d" : "f"} ${e.path}${e.size != null ? ` (${e.size}b)` : ""}`,
      );
      if (entries.length > MAX_DIR_ENTRIES) {
        lines.push(`… ${entries.length - MAX_DIR_ENTRIES} more entries omitted`);
      }
      return lines.join("\n");
    }

    if (name === "read_file") {
      const path = String(input.path ?? "");
      if (isPathBlocked(path)) {
        return `Refused: path "${path}" is blocked (generated / vendored).`;
      }
      const file = await getFileContent({
        token: ctx.token,
        owner: ctx.owner,
        repo: ctx.repo,
        path,
        ref: ctx.ref,
      });
      if (!file) return `File not found: ${path}`;
      return truncate(file.content, MAX_FILE_READ_BYTES);
    }

    if (name === "search_code") {
      const query = String(input.query ?? "");
      if (!query) return "Empty query.";
      const hits = await searchRepoCode({
        token: ctx.token,
        owner: ctx.owner,
        repo: ctx.repo,
        query,
      });
      if (hits.length === 0) return `No matches for "${query}".`;
      return hits
        .slice(0, 30)
        .map((h) => h.path)
        .join("\n");
    }

    if (name === "write_file") {
      const path = String(input.path ?? "");
      const content = String(input.content ?? "");
      if (isPathBlocked(path)) {
        return `Refused: path "${path}" is blocked (generated / vendored).`;
      }
      if (content.length > MAX_FILE_WRITE_BYTES) {
        return `Refused: ${content.length} bytes exceeds per-file cap of ${MAX_FILE_WRITE_BYTES}.`;
      }
      const prevSize = ctx.state.writes.get(path)?.length ?? 0;
      const newTotal = ctx.state.totalWriteBytes - prevSize + content.length;
      if (newTotal > MAX_TOTAL_WRITE_BYTES) {
        return `Refused: total write size would exceed ${MAX_TOTAL_WRITE_BYTES} bytes.`;
      }
      ctx.state.writes.set(path, content);
      ctx.state.totalWriteBytes = newTotal;
      return `Staged ${path} (${content.length} bytes). Total staged: ${ctx.state.writes.size} file(s), ${ctx.state.totalWriteBytes} bytes.`;
    }

    if (name === "done") {
      ctx.state.explanation = String(input.summary ?? "");
      ctx.state.doneReached = true;
      return "Done received. The system will commit your staged writes and open the PR.";
    }

    return `Unknown tool: ${name}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const BRANCH_PREFIX = "crawlproof/fix";

function toolProgressLabel(
  name: string,
  input: Record<string, unknown>,
): string {
  if (name === "list_directory") {
    return `Listing ${String(input.path ?? "") || "repo root"}`;
  }
  if (name === "read_file") {
    return `Reading ${String(input.path ?? "")}`;
  }
  if (name === "search_code") {
    return `Searching for "${String(input.query ?? "").slice(0, 80)}"`;
  }
  if (name === "write_file") {
    return `Staging ${String(input.path ?? "")}`;
  }
  if (name === "done") {
    return "Claude marked the fix complete";
  }
  return `Running ${name}`;
}

export async function applyFix(input: ApplyFixInput): Promise<ApplyFixResult> {
  const progress = async (message: string) => {
    await input.onProgress?.(message);
  };

  if (!env.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured.");
  }
  await progress(`Reading repository metadata for ${input.owner}/${input.repo}…`);
  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  const repoMeta = await getRepo({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
  });
  const ref = repoMeta.default_branch;
  await progress(`Default branch is ${ref}. Preparing Claude fix agent…`);

  const state: RunState = {
    writes: new Map(),
    totalWriteBytes: 0,
    explanation: "",
    doneReached: false,
  };

  const system = buildSystemPrompt(input.owner, input.repo);
  const userPrompt = buildApplyFixUserPrompt({
    finding: input.finding,
    targetUrl: input.targetUrl,
    defaultBranch: ref,
    rootPath: input.rootPath,
    userPrompt: input.userPrompt,
  });

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userPrompt },
  ];

  let iteration = 0;
  while (iteration < MAX_ITERATIONS && !state.doneReached) {
    iteration++;
    await progress(`Claude iteration ${iteration}/${MAX_ITERATIONS}: analyzing the finding and repo context…`);
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      // Cache the static system + tools block; the conversation prefix
      // changes per iteration and isn't cached.
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ],
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      // Claude finished without calling done — capture any final text.
      await progress("Claude returned a final response without tool calls.");
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) state.explanation = text;
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const toolInput = (tu.input as Record<string, unknown>) || {};
      await progress(toolProgressLabel(tu.name, toolInput));
      const result = await executeTool(
        tu.name,
        toolInput,
        { token: input.token, owner: input.owner, repo: input.repo, ref, state },
      );
      if (tu.name === "write_file" || tu.name === "done") {
        await progress(result);
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result,
      });
    }
    messages.push({ role: "user", content: toolResults });

    if (state.doneReached) break;
    if (resp.stop_reason === "end_turn" && toolUses.length === 0) break;
  }

  if (state.writes.size === 0) {
    await progress("No file changes were staged. Finishing without opening a PR.");
    return {
      status: "noop",
      detail:
        state.explanation ||
        `Claude explored the repo but didn't stage any changes after ${iteration} iteration(s).`,
    };
  }

  // Commit the staged writes on a new branch.
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeKey = input.finding.check_key.replace(/[^a-z0-9.]/gi, "-");
  const branch = `${BRANCH_PREFIX}/${safeKey}-${ts}`;
  await progress(`Creating branch ${branch} from ${ref}…`);
  await createBranch({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    newBranch: branch,
    fromBranch: ref,
  });

  // For each staged write, look up the existing sha so the PUT replaces
  // rather than failing with "sha required".
  const changed: string[] = [];
  await progress(`Writing ${state.writes.size} staged file change${state.writes.size === 1 ? "" : "s"} to GitHub…`);
  for (const [path, content] of state.writes) {
    await progress(`Updating ${path}…`);
    const existing = await getFileContent({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path,
      ref,
    });
    await putFile({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path,
      branch,
      message: `Fix ${input.finding.check_key}: ${input.finding.title}`,
      contentUtf8: content,
      sha: existing?.sha,
    });
    changed.push(path);
  }

  await progress("Opening pull request…");
  const pr = await openPullRequest({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    head: branch,
    base: ref,
    title: `CrawlProof fix: ${input.finding.title}`,
    body: prBody(input.finding, state.explanation, changed, iteration, input.userPrompt),
  });

  return {
    status: "opened",
    prUrl: pr.html_url,
    prNumber: pr.number,
    branch,
    changedPaths: changed,
    detail: `Opened PR with ${changed.length} file change(s) after ${iteration} agent iteration(s).`,
  };
}

function prBody(
  finding: FindingInput,
  explanation: string,
  changed: string[],
  iterations: number,
  userPrompt?: string,
): string {
  return `**CrawlProof automated fix** for the following audit finding:

> **${finding.title}**
> ${finding.detail ?? ""}

**Check:** \`${finding.check_key}\` (priority ${finding.priority})

**What changed:**
${changed.map((p) => `- \`${p}\``).join("\n")}

**Why:**
${explanation || "(no summary provided)"}
${userPrompt?.trim() ? `\n**User guidance:**\n${userPrompt.trim()}\n` : ""}

---

Generated by Claude Sonnet 4.6 in agentic mode (${iterations} tool iteration${iterations === 1 ? "" : "s"}). Review the diff before merging — automated edits are not infallible. Disagree with the change? Close the PR and apply the fix manually using the audit recommendations on your CrawlProof project page.

Docs: ${env.siteUrl}/docs/aeo-score`;
}
