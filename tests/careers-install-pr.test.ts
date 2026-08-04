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
  createBranch: github.createBranch,
  putFile: github.putFile,
  openPullRequest: github.openPullRequest,
}));

import { detectFramework, installCareersPage } from "@/lib/github/install-careers";

const BASE = { token: "token", owner: "owner", repo: "repo" };
const PROJECT = "af9ab953-caa6-4a2b-a306-42fb4eac4630";

beforeEach(() => {
  github.files.clear();
  for (const fn of [
    github.getRepo,
    github.getFileContent,
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
