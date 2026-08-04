// Open a pull request adding a real server-rendered /careers page to a
// customer's repo.
//
// This is the counterpart to the drop-in widget, not a replacement for it. The
// widget needs no install and paints the board client-side; that is invisible
// to crawlers, so a job board that exists only as JavaScript will not be read
// by search or answer engines. This installer writes an actual route so the
// roles ship as HTML on the customer's own domain, and the widget then upgrades
// that same markup into the inline application form.
//
// Deterministic, like install-tracker and install-ad: no LLM, no guessing. We
// add a file only where we can positively identify the framework and the route
// directory. Every other repo gets an honest no-op explaining that the widget
// already covers them — writing a speculative page into someone's repo is worse
// than not opening a PR at all.

import { env } from "@/lib/env";
import {
  careersRouteFiles,
  conflictingPaths,
  type CareersFramework,
} from "@/lib/careers/page-templates";
import { createBranch, getFileContent, getRepo, openPullRequest, putFile } from "./repos";

const ORIGIN = env.siteUrl.replace(/\/+$/, "");
const BRANCH_PREFIX = "crawlproof/careers-page";

export interface DetectedFramework {
  framework: CareersFramework;
  /** Directory the route belongs in, repo-relative. */
  dir: string;
  typescript: boolean;
  /** The file that gave the framework away, for the PR body. */
  evidence: string;
}

export interface InstallCareersInput {
  token: string;
  owner: string;
  repo: string;
  projectId: string;
  /** Subdirectory inside the repo where the site lives, e.g. "apps/web". */
  rootPath?: string;
  /** Skip detection; used by tests and by callers that already probed. */
  detected?: DetectedFramework;
}

export interface InstallCareersResult {
  status: "opened" | "noop";
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  framework?: CareersFramework;
  /** Files the PR adds. */
  paths?: string[];
  detail: string;
}

function joinPath(root: string, rest: string): string {
  const base = root.replace(/^\/+/, "").replace(/\/+$/, "");
  return base ? `${base}/${rest}` : rest;
}

/**
 * Identify the framework by looking for files only that framework has.
 *
 * Astro is checked first: an Astro repo has no app/layout.tsx, so the order
 * only matters for the mixed monorepo case, where the config file at the given
 * root is the better signal.
 */
export async function detectFramework(input: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
  rootPath?: string;
}): Promise<DetectedFramework | null> {
  const root = input.rootPath ?? "";
  const probe = async (path: string) =>
    getFileContent({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path: joinPath(root, path),
      ref: input.ref,
    });

  for (const config of ["astro.config.mjs", "astro.config.ts", "astro.config.js", "astro.config.cjs"]) {
    if (await probe(config)) {
      return {
        framework: "astro",
        dir: joinPath(root, "src/pages"),
        typescript: true, // Astro frontmatter is TypeScript regardless.
        evidence: joinPath(root, config),
      };
    }
  }

  // App Router only. The Pages Router and the older getStaticProps shapes are
  // different enough that a shared template would be a guess.
  const layouts: Array<[string, boolean]> = [
    ["app/layout.tsx", true],
    ["app/layout.jsx", false],
    ["app/layout.js", false],
    ["src/app/layout.tsx", true],
    ["src/app/layout.jsx", false],
    ["src/app/layout.js", false],
  ];
  for (const [path, typescript] of layouts) {
    if (await probe(path)) {
      return {
        framework: "next-app",
        dir: joinPath(root, path.replace(/\/layout\.[a-z]+$/, "")),
        typescript,
        evidence: joinPath(root, path),
      };
    }
  }

  return null;
}

const UNSUPPORTED =
  "Could not find a Next.js App Router or Astro site in this repo, so nothing was changed. " +
  "Your careers board still works through the tracker snippet — it just renders client-side.";

export async function installCareersPage(
  input: InstallCareersInput,
): Promise<InstallCareersResult> {
  const repoMeta = await getRepo({ token: input.token, owner: input.owner, repo: input.repo });
  const base = repoMeta.default_branch;

  const detected =
    input.detected ??
    (await detectFramework({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      ref: base,
      rootPath: input.rootPath,
    }));
  if (!detected) return { status: "noop", detail: UNSUPPORTED };

  // Never overwrite a careers page they already have — theirs may be hand
  // written, and a PR that clobbers it is a PR that gets us uninstalled.
  for (const path of conflictingPaths(detected.framework, detected.dir)) {
    const existing = await getFileContent({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path,
      ref: base,
    });
    if (existing) {
      return {
        status: "noop",
        framework: detected.framework,
        paths: [path],
        detail: `This repo already has a careers page at ${path}; left untouched.`,
      };
    }
  }

  const files = careersRouteFiles(detected.framework, {
    origin: ORIGIN,
    projectId: input.projectId,
    dir: detected.dir,
    typescript: detected.typescript,
  });

  const branch = `${BRANCH_PREFIX}-${input.projectId.slice(0, 8)}-${Date.now().toString(36)}`;
  await createBranch({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    newBranch: branch,
    fromBranch: base,
  });

  for (const file of files) {
    await putFile({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path: file.path,
      branch,
      message: "Add server-rendered careers page",
      contentUtf8: file.content,
    });
  }

  const paths = files.map((f) => f.path);
  const pr = await openPullRequest({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    head: branch,
    base,
    title: "Add a server-rendered careers page",
    body: [
      "This PR adds a `/careers` page that renders your open roles as HTML on your own domain.",
      "",
      `- Detected **${detected.framework === "astro" ? "Astro" : "Next.js (App Router)"}** from \`${detected.evidence}\`.`,
      `- Added ${paths.map((p) => `\`${p}\``).join(", ")}.`,
      detected.framework === "astro"
        ? "- Roles are fetched from CrawlProof when the page renders. On a statically built Astro site that means at build time, so redeploy (or switch this route to on-demand rendering) to pick up new roles."
        : "- Roles are fetched from CrawlProof at request time and cached for 5 minutes. Edit them in the dashboard, not in this file.",
      "- Each role ships with `JobPosting` structured data in the server HTML, which is what Google for Jobs and answer engines read.",
      "",
      "The page is deliberately unstyled — it inherits your site's CSS and is yours to restyle.",
      "If the CrawlProof tracker is installed, its widget replaces the rendered list with an inline application form; without it, each role links to its hosted application page.",
      "",
      `Manage roles at ${ORIGIN}/projects/${input.projectId}/stats/careers`,
    ].join("\n"),
  });

  return {
    status: "opened",
    prUrl: pr.html_url,
    prNumber: pr.number,
    branch,
    framework: detected.framework,
    paths,
    detail: `Opened PR #${pr.number} adding ${paths.join(", ")}.`,
  };
}
