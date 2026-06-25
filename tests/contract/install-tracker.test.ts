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
    putFile: vi.fn(async ({ path }: { path: string; contentUtf8: string }) => ({
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

import {
  findInstallCandidates,
  installTracker,
  patchCspForTracker,
} from "@/lib/github/install-tracker";

describe("install tracker candidate discovery", () => {
  beforeEach(() => {
    github.files.clear();
    github.getRepo.mockClear();
    github.getFileContent.mockClear();
    github.searchRepoCode.mockClear();
    github.createBranch.mockClear();
    github.putFile.mockClear();
    github.openPullRequest.mockClear();
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

  it("finds a static apps/web/public/index.html without code search", async () => {
    github.files.set(
      "apps/web/public/index.html",
      "<!doctype html>\n<html><head></head><body>\n<h1>Hi</h1>\n</body></html>\n",
    );

    const candidates = await findInstallCandidates({
      token: "token",
      owner: "owner",
      repo: "repo",
    });

    expect(candidates.map((c) => c.path)).toContain(
      "apps/web/public/index.html",
    );
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

  it("patches CSP directives for the tracker origin", () => {
    const before = `const csp = [
  "default-src 'self'",
  "script-src 'self' https://datafa.st",
  "connect-src 'self' https://datafa.st",
].join('; ');`;

    const after = patchCspForTracker(before);

    expect(after).toContain(
      "script-src 'self' https://datafa.st http://localhost:3000",
    );
    expect(after).toContain(
      "connect-src 'self' https://datafa.st http://localhost:3000",
    );
    expect(patchCspForTracker(after!)).toBeNull();
  });

  it("opens a CSP-only PR when the tracker snippet is already installed", async () => {
    github.files.set(
      "app/layout.tsx",
      `export default function RootLayout({ children }) {
  return <html><body>{children}<Script data-site="project-id" src="http://localhost:3000/stats.js" strategy="afterInteractive" /></body></html>;
}
`,
    );
    github.files.set(
      "next.config.mjs",
      `const SECURITY_HEADERS = [{
  key: 'Content-Security-Policy',
  value: [
    "default-src 'self'",
    "script-src 'self' https://datafa.st",
    "connect-src 'self' https://datafa.st",
  ].join('; '),
}];`,
    );

    const result = await installTracker({
      token: "token",
      owner: "owner",
      repo: "repo",
      projectId: "project-id",
      targetPath: "app/layout.tsx",
    });

    expect(result.status).toBe("opened");
    expect(result.cspPaths).toEqual(["next.config.mjs"]);
    expect(github.putFile).toHaveBeenCalledTimes(1);
    expect(github.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "next.config.mjs",
        message: "Allow CrawlProof stats in CSP",
        contentUtf8: expect.stringContaining("http://localhost:3000"),
      }),
    );
  });

  it("replaces an existing CrawlProof tracker for a different project", async () => {
    github.files.set(
      "app/layout.tsx",
      `import Script from "next/script";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Script data-site="old-project-id" src="http://localhost:3000/stats.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
`,
    );

    const result = await installTracker({
      token: "token",
      owner: "owner",
      repo: "repo",
      projectId: "new-project-id",
      targetPath: "app/layout.tsx",
    });

    expect(result.status).toBe("opened");
    expect(github.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "app/layout.tsx",
        contentUtf8: expect.stringContaining('data-site="new-project-id"'),
      }),
    );
    const written = github.putFile.mock.calls[0][0].contentUtf8;
    expect(written).not.toContain("old-project-id");
  });

  it("removes duplicate CrawlProof tracker snippets when the current project is present", async () => {
    github.files.set(
      "app/layout.tsx",
      `import Script from "next/script";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Script data-site="old-project-id" src="http://localhost:3000/stats.js" strategy="afterInteractive" />
        <Script data-site="new-project-id" src="http://localhost:3000/stats.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
`,
    );

    const result = await installTracker({
      token: "token",
      owner: "owner",
      repo: "repo",
      projectId: "new-project-id",
      targetPath: "app/layout.tsx",
    });

    expect(result.status).toBe("opened");
    const written = github.putFile.mock.calls[0][0].contentUtf8;
    expect(written).toContain('data-site="new-project-id"');
    expect(written).not.toContain("old-project-id");
    expect(written.match(/stats\.js/g)).toHaveLength(1);
  });
});
