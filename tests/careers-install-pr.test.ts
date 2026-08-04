import { beforeEach, describe, expect, it, vi } from "vitest";

// The installer writes to a customer's repository, so the rules that matter
// most are the ones about NOT writing: no framework, or a careers page that
// already exists, must leave the repo untouched.

const github = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    getRepo: vi.fn(async () => ({
      default_branch: "main",
      full_name: "owner/repo",
      private: false,
      id: 1,
    })),
    getFileContent: vi.fn(async ({ path }: { path: string }) => {
      const content = files.get(path);
      if (!content) return null;
      return { path, sha: `sha-${path}`, content };
    }),
    searchRepoCode: vi.fn(async () => []),
    listRepoTree: vi.fn(async () => ({ files: [...files.keys()], truncated: false })),
    createBranch: vi.fn(async (_input: { newBranch: string; fromBranch: string }) => ({
      created: true,
    })),
    putFile: vi.fn(async ({ path }: { path: string; contentUtf8: string }) => ({
      content: { sha: `new-sha-${path}`, path },
      commit: { sha: "commit-sha" },
    })),
    openPullRequest: vi.fn(
      async (_input: { base: string; head: string; title: string; body: string }) => ({
        html_url: "https://github.test/owner/repo/pull/12",
        number: 12,
        state: "open",
      }),
    ),
  };
});

vi.mock("@/lib/github/repos", () => ({
  getRepo: github.getRepo,
  getFileContent: github.getFileContent,
  searchRepoCode: github.searchRepoCode,
  listRepoTree: github.listRepoTree,
  createBranch: github.createBranch,
  putFile: github.putFile,
  openPullRequest: github.openPullRequest,
}));

import {
  careersCandidatesFromTree,
  detectFramework,
  findCareersCandidates,
  installCareersPage,
  verifyCareersDir,
} from "@/lib/github/install-careers";

const BASE = { token: "token", owner: "owner", repo: "repo" };
const PROJECT = "af9ab953-caa6-4a2b-a306-42fb4eac4630";

beforeEach(() => {
  github.files.clear();
  for (const fn of [
    github.getRepo,
    github.getFileContent,
    github.listRepoTree,
    github.createBranch,
    github.putFile,
    github.openPullRequest,
  ]) {
    fn.mockClear();
  }
});

describe("detectFramework", () => {
  it("finds a Next App Router app and infers TypeScript from the layout", async () => {
    github.files.set("app/layout.tsx", "export default function L() {}");
    const found = await detectFramework({ ...BASE, ref: "main" });
    expect(found).toMatchObject({
      framework: "next-app",
      dir: "app",
      typescript: true,
      evidence: "app/layout.tsx",
    });
  });

  it("infers JavaScript from a .js layout", async () => {
    github.files.set("src/app/layout.js", "export default function L() {}");
    const found = await detectFramework({ ...BASE, ref: "main" });
    expect(found).toMatchObject({ framework: "next-app", dir: "src/app", typescript: false });
  });

  it("finds Astro from its config", async () => {
    github.files.set("astro.config.mjs", "export default {};");
    const found = await detectFramework({ ...BASE, ref: "main" });
    expect(found).toMatchObject({ framework: "astro", dir: "src/pages" });
  });

  it("scopes detection to a monorepo subdirectory", async () => {
    github.files.set("apps/web/app/layout.tsx", "export default function L() {}");
    const found = await detectFramework({ ...BASE, ref: "main", rootPath: "apps/web" });
    expect(found).toMatchObject({ dir: "apps/web/app", evidence: "apps/web/app/layout.tsx" });
  });

  it("returns null for a repo it doesn't recognise", async () => {
    github.files.set("index.html", "<html><body></body></html>");
    expect(await detectFramework({ ...BASE, ref: "main" })).toBeNull();
  });
});

describe("installCareersPage", () => {
  it("opens a PR adding the Next page", async () => {
    github.files.set("app/layout.tsx", "export default function L() {}");

    const result = await installCareersPage({ ...BASE, projectId: PROJECT });

    expect(result.status).toBe("opened");
    expect(result.paths).toEqual(["app/careers/page.tsx"]);
    expect(result.prUrl).toBe("https://github.test/owner/repo/pull/12");
    expect(github.putFile).toHaveBeenCalledTimes(1);

    const written = github.putFile.mock.calls[0][0] as unknown as {
      path: string;
      contentUtf8: string;
      branch: string;
    };
    expect(written.path).toBe("app/careers/page.tsx");
    expect(written.contentUtf8).toContain(`site=${PROJECT}`);
    // New file: no sha, or GitHub rejects the write.
    expect((written as { sha?: string }).sha).toBeUndefined();
    expect(written.branch).toMatch(/^crawlproof\/careers-page-/);
  });

  it("opens a PR adding the Astro page", async () => {
    github.files.set("astro.config.ts", "export default {};");
    const result = await installCareersPage({ ...BASE, projectId: PROJECT });
    expect(result.status).toBe("opened");
    expect(result.paths).toEqual(["src/pages/careers.astro"]);
  });

  it("names the framework and the evidence in the PR body", async () => {
    github.files.set("app/layout.tsx", "export default function L() {}");
    await installCareersPage({ ...BASE, projectId: PROJECT });
    const pr = github.openPullRequest.mock.calls[0][0] as unknown as {
      body: string;
      title: string;
    };
    expect(pr.body).toContain("Next.js (App Router)");
    expect(pr.body).toContain("app/layout.tsx");
    expect(pr.body).toContain("JobPosting");
    expect(pr.title).toBe("Add a server-rendered careers page");
  });

  it("tells an Astro user their roles update on deploy, not on request", async () => {
    github.files.set("astro.config.mjs", "export default {};");
    await installCareersPage({ ...BASE, projectId: PROJECT });
    const pr = github.openPullRequest.mock.calls[0][0] as unknown as { body: string };
    expect(pr.body).toContain("build time");
    expect(pr.body).not.toContain("cached for 5 minutes");
  });

  it("changes nothing when it can't identify the framework", async () => {
    github.files.set("index.html", "<html><body></body></html>");

    const result = await installCareersPage({ ...BASE, projectId: PROJECT });

    expect(result.status).toBe("noop");
    expect(result.detail).toContain("client-side");
    expect(github.createBranch).not.toHaveBeenCalled();
    expect(github.putFile).not.toHaveBeenCalled();
    expect(github.openPullRequest).not.toHaveBeenCalled();
  });

  it("refuses to overwrite a careers page they already have", async () => {
    github.files.set("app/layout.tsx", "export default function L() {}");
    github.files.set("app/careers/page.tsx", "export default function Mine() {}");

    const result = await installCareersPage({ ...BASE, projectId: PROJECT });

    expect(result.status).toBe("noop");
    expect(result.detail).toContain("already has a careers page");
    expect(github.putFile).not.toHaveBeenCalled();
    expect(github.openPullRequest).not.toHaveBeenCalled();
  });

  it("spots an existing page written in another dialect", async () => {
    github.files.set("app/layout.tsx", "export default function L() {}");
    github.files.set("app/careers/page.js", "module.exports = {};");

    const result = await installCareersPage({ ...BASE, projectId: PROJECT });
    expect(result.status).toBe("noop");
    expect(github.putFile).not.toHaveBeenCalled();
  });

  it("branches from the repo's own default branch", async () => {
    github.getRepo.mockResolvedValueOnce({
      default_branch: "trunk",
      full_name: "owner/repo",
      private: false,
      id: 1,
    });
    github.files.set("app/layout.tsx", "export default function L() {}");

    await installCareersPage({ ...BASE, projectId: PROJECT });

    const branchCall = github.createBranch.mock.calls[0][0] as unknown as {
      fromBranch: string;
    };
    expect(branchCall.fromBranch).toBe("trunk");
    const pr = github.openPullRequest.mock.calls[0][0] as unknown as { base: string };
    expect(pr.base).toBe("trunk");
  });
});

// The scan is the difference between "we don't support your repo" and "pick
// one of these". Most of the interesting behaviour is in the pure tree->list
// step, so that gets tested without any network mocking at all.
describe("careersCandidatesFromTree", () => {
  it("finds every app dir in a monorepo, not just the root", () => {
    const found = careersCandidatesFromTree(
      [
        "package.json",
        "apps/web/src/app/layout.tsx",
        "apps/admin/app/layout.tsx",
        "packages/ui/package.json",
      ],
      { repoName: "acme" },
    );
    expect(found.map((c) => c.dir).sort()).toEqual([
      "apps/admin/app",
      "apps/web/src/app",
    ]);
  });

  it("ranks the real app above examples and fixtures", () => {
    const found = careersCandidatesFromTree(
      ["examples/starter/app/layout.tsx", "apps/web/app/layout.tsx"],
      { repoName: "acme" },
    );
    expect(found[0].dir).toBe("apps/web/app");
    expect(found[1].dir).toBe("examples/starter/app");
  });

  it("puts a root-level app dir first in a single-app repo", () => {
    const found = careersCandidatesFromTree(
      ["apps/legacy/app/layout.tsx", "app/layout.tsx"],
      { repoName: "acme" },
    );
    expect(found[0].dir).toBe("app");
  });

  it("maps an Astro config to its pages directory", () => {
    const found = careersCandidatesFromTree(
      ["sites/blog/astro.config.mjs", "sites/blog/src/pages/index.astro"],
      { repoName: "acme" },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      framework: "astro",
      dir: "sites/blog/src/pages",
      evidence: "sites/blog/astro.config.mjs",
      typescript: true,
    });
  });

  it("ignores nested route layouts — only the root layout marks an app dir", () => {
    const found = careersCandidatesFromTree(
      ["app/layout.tsx", "app/blog/layout.tsx", "app/(marketing)/layout.tsx"],
      { repoName: "acme" },
    );
    expect(found.map((c) => c.dir)).toEqual(["app"]);
  });

  it("skips vendored and build output", () => {
    const found = careersCandidatesFromTree(
      ["node_modules/pkg/app/layout.tsx", ".next/app/layout.tsx", "dist/app/layout.tsx"],
      { repoName: "acme" },
    );
    expect(found).toEqual([]);
  });

  it("honours a rootPath filter", () => {
    const found = careersCandidatesFromTree(
      ["apps/web/app/layout.tsx", "apps/admin/app/layout.tsx"],
      { repoName: "acme", rootPath: "apps/admin" },
    );
    expect(found.map((c) => c.dir)).toEqual(["apps/admin/app"]);
  });

  it("surfaces a location that already has a careers page instead of hiding it", () => {
    const found = careersCandidatesFromTree(
      ["app/layout.tsx", "app/careers/page.tsx"],
      { repoName: "acme" },
    );
    expect(found[0].existingPath).toBe("app/careers/page.tsx");
  });

  it("infers JavaScript from a .jsx layout", () => {
    const found = careersCandidatesFromTree(["app/layout.jsx"], { repoName: "acme" });
    expect(found[0]).toMatchObject({ typescript: false, framework: "next-app" });
  });
});

describe("findCareersCandidates", () => {
  it("scans the whole repo in one tree call", async () => {
    github.files.set("apps/web/src/app/layout.tsx", "export default function L() {}");
    const { candidates, truncated } = await findCareersCandidates({ ...BASE });
    expect(candidates.map((c) => c.dir)).toEqual(["apps/web/src/app"]);
    expect(truncated).toBe(false);
    expect(github.listRepoTree).toHaveBeenCalledTimes(1);
  });

  it("falls back to the direct probe when the tree is unavailable", async () => {
    github.listRepoTree.mockRejectedValueOnce(new Error("409 empty repository"));
    github.files.set("app/layout.tsx", "export default function L() {}");
    const { candidates } = await findCareersCandidates({ ...BASE });
    expect(candidates.map((c) => c.dir)).toEqual(["app"]);
  });

  it("keeps probing when GitHub truncates the tree", async () => {
    github.files.set("app/layout.tsx", "export default function L() {}");
    github.listRepoTree.mockResolvedValueOnce({ files: [], truncated: true });
    const { candidates, truncated } = await findCareersCandidates({ ...BASE });
    expect(truncated).toBe(true);
    expect(candidates.map((c) => c.dir)).toEqual(["app"]);
  });

  it("returns an empty list rather than throwing on a repo with no site", async () => {
    github.files.set("README.md", "# hi");
    const { candidates } = await findCareersCandidates({ ...BASE });
    expect(candidates).toEqual([]);
  });
});

// A directory picked in the browser is user input. The installer's promise is
// that it only writes where it can see a site, so submit re-checks the marker.
describe("verifyCareersDir", () => {
  it("accepts a directory that really holds a root layout", async () => {
    github.files.set("apps/web/app/layout.tsx", "export default function L() {}");
    const found = await verifyCareersDir({ ...BASE, ref: "main", dir: "apps/web/app" });
    expect(found).toMatchObject({
      framework: "next-app",
      dir: "apps/web/app",
      typescript: true,
      evidence: "apps/web/app/layout.tsx",
    });
  });

  it("rejects a directory with no framework marker", async () => {
    github.files.set("apps/web/app/layout.tsx", "export default function L() {}");
    const found = await verifyCareersDir({ ...BASE, ref: "main", dir: "docs" });
    expect(found).toBeNull();
  });

  it("rejects traversal", async () => {
    const found = await verifyCareersDir({ ...BASE, ref: "main", dir: "../../etc" });
    expect(found).toBeNull();
  });

  it("verifies an Astro pages dir against the config above it", async () => {
    github.files.set("sites/blog/astro.config.ts", "export default {};");
    const found = await verifyCareersDir({
      ...BASE,
      ref: "main",
      dir: "sites/blog/src/pages",
    });
    expect(found).toMatchObject({
      framework: "astro",
      dir: "sites/blog/src/pages",
      evidence: "sites/blog/astro.config.ts",
    });
  });
});
