import { beforeEach, describe, expect, it, vi } from "vitest";

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
    createBranch: vi.fn(async () => ({ created: true })),
    putFile: vi.fn(async ({ path }: { path: string }) => ({
      content: { sha: `new-sha-${path}`, path },
      commit: { sha: "commit-sha" },
    })),
    openPullRequest: vi.fn(async () => ({
      html_url: "https://github.test/owner/repo/pull/1",
      number: 1,
      state: "open",
    })),
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

import { findInstallCandidates } from "@/lib/github/install-tracker";

describe("install tracker candidate discovery", () => {
  beforeEach(() => {
    github.files.clear();
    github.getRepo.mockClear();
    github.getFileContent.mockClear();
    github.searchRepoCode.mockClear();
  });

  it("finds apps/web/src/app/layout.tsx without relying on code search", async () => {
    github.files.set(
      "apps/web/src/app/layout.tsx",
      "export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n",
    );

    const candidates = await findInstallCandidates({
      token: "token",
      owner: "owner",
      repo: "repo",
    });

    expect(candidates.map((c) => c.path)).toContain(
      "apps/web/src/app/layout.tsx",
    );
    expect(github.searchRepoCode).toHaveBeenCalledOnce();
  });

  it("does not double-prefix common monorepo candidates when rootPath is set", async () => {
    github.files.set(
      "apps/web/src/app/layout.tsx",
      "export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n",
    );

    const candidates = await findInstallCandidates({
      token: "token",
      owner: "owner",
      repo: "repo",
      rootPath: "apps/web",
    });

    expect(candidates.map((c) => c.path)).toContain(
      "apps/web/src/app/layout.tsx",
    );
    expect(github.getFileContent).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "apps/web/apps/web/src/app/layout.tsx" }),
    );
  });
});
