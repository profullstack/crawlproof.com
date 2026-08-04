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
import {
  createBranch,
  getFileContent,
  getRepo,
  listRepoTree,
  openPullRequest,
  putFile,
} from "./repos";

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

// ---------------------------------------------------------------------------
// Candidate discovery
//
// detectFramework() answers "is there a site exactly here?", which is the wrong
// question for a monorepo: the customer has to already know their own route
// directory and type it in, and one wrong guess reads as "CrawlProof doesn't
// support my repo". The tracker installer solved this by scanning and ranking
// (findInstallCandidates); this is the same idea for careers routes. One
// recursive tree request gets the whole file list, so the UI can offer real
// locations instead of asking anyone to guess.
// ---------------------------------------------------------------------------

/** `app/layout.tsx` at any depth — a Next App Router root layout, not a nested one. */
const NEXT_ROOT_LAYOUT = /(?:^|\/)app\/layout\.(tsx|jsx|js)$/;
/** An Astro project marker at any depth. */
const ASTRO_CONFIG = /(?:^|\/)astro\.config\.(mjs|ts|js|cjs)$/;

/** Paths we never want to offer: vendored code and tooling scratch space. */
const IGNORED_PATH = /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|vendor)(\/|$)/;

export interface CareersCandidate extends DetectedFramework {
  /** Higher is better; the UI shows the list best-first. */
  score: number;
  /** Set when a careers page already lives here. The UI offers it but warns. */
  existingPath?: string;
}

/**
 * Rank a route directory. Tuned like rankCandidatePath in install-tracker: the
 * production app in a monorepo lives under apps/* or sites/*, and example or
 * fixture directories are never what someone wants a public careers page in.
 */
function rankCareersDir(dir: string, repoName: string): number {
  let score = 0;
  if (
    /(^|\/)(boilerplates?|examples?|templates?|samples?|fixtures?|__tests__|tests?|spec|stories|playground|sandbox|demo)(\/|$)/i.test(
      dir,
    )
  ) {
    score -= 100;
  }
  if (/(^|\/)(docs?|documentation)(\/|$)/i.test(dir)) score -= 20;
  if (/(^|\/)apps\//i.test(dir)) score += 30;
  if (/(^|\/)sites\//i.test(dir)) score += 30;
  if (/(^|\/)(web|www|site|frontend|marketing)(\/|$)/i.test(dir)) score += 20;
  // A repo-name match disambiguates sites/acme.com from sites/scratch. Skip
  // very short names, where the substring hit would be noise.
  if (repoName.length >= 3 && dir.toLowerCase().includes(repoName.toLowerCase())) {
    score += 25;
  }
  // The single-app repo: the route dir sits right at the top.
  if (dir === "app" || dir === "src/app" || dir === "src/pages") score += 50;
  // Shorter paths are closer to the canonical site.
  score -= dir.length * 0.05;
  return score;
}

/** Turn a repo file list into the set of places a careers route could go. */
export function careersCandidatesFromTree(
  files: string[],
  opts: { repoName: string; rootPath?: string },
): CareersCandidate[] {
  const root = (opts.rootPath ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  const inScope = (path: string) =>
    !IGNORED_PATH.test(path) && (!root || path === root || path.startsWith(`${root}/`));

  const byDir = new Map<string, CareersCandidate>();

  for (const path of files) {
    if (!inScope(path)) continue;

    if (ASTRO_CONFIG.test(path)) {
      const siteRoot = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const dir = siteRoot ? `${siteRoot}/src/pages` : "src/pages";
      if (!byDir.has(dir)) {
        byDir.set(dir, {
          framework: "astro",
          dir,
          typescript: true, // Astro frontmatter is TypeScript regardless.
          evidence: path,
          score: rankCareersDir(dir, opts.repoName),
        });
      }
      continue;
    }

    const next = NEXT_ROOT_LAYOUT.exec(path);
    if (next) {
      const dir = path.replace(/\/layout\.[a-z]+$/, "");
      if (!byDir.has(dir)) {
        byDir.set(dir, {
          framework: "next-app",
          dir,
          typescript: next[1] === "tsx",
          evidence: path,
          score: rankCareersDir(dir, opts.repoName),
        });
      }
    }
  }

  // Flag the ones that already have a page, rather than hiding them — "you
  // already have this" is a more useful answer than an empty list.
  const present = new Set(files);
  const candidates = [...byDir.values()].map((c) => {
    const clash = conflictingPaths(c.framework, c.dir).find((p) => present.has(p));
    return clash ? { ...c, existingPath: clash } : c;
  });

  candidates.sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir));
  return candidates;
}

/**
 * Scan a repo for every place a careers route could go, best first.
 *
 * Falls back to the single-root probe when the tree is unavailable or GitHub
 * truncated it, so a huge repo degrades to the old behaviour instead of
 * claiming the site doesn't exist.
 */
export async function findCareersCandidates(input: {
  token: string;
  owner: string;
  repo: string;
  rootPath?: string;
  ref?: string;
}): Promise<{ candidates: CareersCandidate[]; truncated: boolean }> {
  let ref = input.ref;
  if (!ref) {
    const repoMeta = await getRepo({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
    });
    ref = repoMeta.default_branch;
  }

  let tree: Awaited<ReturnType<typeof listRepoTree>> = null;
  try {
    tree = await listRepoTree({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      ref,
    });
  } catch {
    // Tree is the fast path, not the only path.
  }

  const candidates = tree
    ? careersCandidatesFromTree(tree.files, {
        repoName: input.repo,
        rootPath: input.rootPath,
      })
    : [];

  // Union with the direct probe. It costs a few contents calls and it is the
  // only thing that still works on a truncated tree.
  if (!tree || tree.truncated || candidates.length === 0) {
    const detected = await detectFramework({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      ref,
      rootPath: input.rootPath,
    });
    if (detected && !candidates.some((c) => c.dir === detected.dir)) {
      candidates.push({
        ...detected,
        score: rankCareersDir(detected.dir, input.repo),
      });
      candidates.sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir));
    }
  }

  return { candidates, truncated: Boolean(tree?.truncated) };
}

/**
 * Confirm a directory really is what it claims before writing to it.
 *
 * The picker and the manual-path box both hand us a directory chosen in the
 * browser; trusting it would let a stray value drop a page into an arbitrary
 * folder. Re-probing for the framework marker keeps the installer's promise
 * that it only writes where it positively identified a site.
 */
export async function verifyCareersDir(input: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
  dir: string;
}): Promise<DetectedFramework | null> {
  const dir = input.dir.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!dir || dir.split("/").includes("..")) return null;

  const probe = async (path: string) =>
    getFileContent({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      path,
      ref: input.ref,
    });

  // "…/src/pages" is Astro's route directory; its marker is the config file
  // that sits two levels up.
  if (/(^|\/)src\/pages$/.test(dir)) {
    const siteRoot = dir.replace(/(^|\/)src\/pages$/, "").replace(/\/+$/, "");
    for (const config of ["astro.config.mjs", "astro.config.ts", "astro.config.js", "astro.config.cjs"]) {
      const path = siteRoot ? `${siteRoot}/${config}` : config;
      if (await probe(path)) {
        return { framework: "astro", dir, typescript: true, evidence: path };
      }
    }
    return null;
  }

  for (const [ext, typescript] of [
    ["tsx", true],
    ["jsx", false],
    ["js", false],
  ] as Array<[string, boolean]>) {
    const path = `${dir}/layout.${ext}`;
    if (await probe(path)) {
      return { framework: "next-app", dir, typescript, evidence: path };
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
