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
      html_url: "https://github.test/owner/repo/pull/7",
      number: 7,
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

import { installAdEmbed, patchCspForAds } from "@/lib/github/install-ad";

const ORIGIN = "http://localhost:3000";

describe("patchCspForAds", () => {
  it("allows the CrawlProof origin on the directives the ad unit needs", () => {
    const before = `const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "frame-src https://www.youtube.com",
].join('; ');`;

    const after = patchCspForAds(before);
    expect(after).not.toBeNull();
    // ad.js, /api/ads/serve, and creative artwork.
    expect(after).toContain(`script-src 'self' ${ORIGIN}`);
    expect(after).toContain(`connect-src 'self' ${ORIGIN}`);
    expect(after).toContain(`img-src 'self' data: ${ORIGIN}`);
    // The srcdoc ad iframe is same-origin — a restrictive frame-src needs 'self'.
    expect(after).toContain("frame-src https://www.youtube.com 'self'");
    // Idempotent.
    expect(patchCspForAds(after!)).toBeNull();
  });

  it("returns null for content that isn't a CSP", () => {
    expect(patchCspForAds("export const x = 1;")).toBeNull();
  });
});

describe("installAdEmbed", () => {
  beforeEach(() => {
    github.files.clear();
    github.getRepo.mockClear();
    github.getFileContent.mockClear();
    github.searchRepoCode.mockClear();
    github.createBranch.mockClear();
    github.putFile.mockClear();
    github.openPullRequest.mockClear();
  });

  it("injects the embed and patches CSP in one PR", async () => {
    github.files.set(
      "app/layout.tsx",
      "export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n",
    );
    github.files.set(
      "next.config.ts",
      `const csp = ["default-src 'self'", "script-src 'self'"].join('; ');\nexport default {};\n`,
    );

    const result = await installAdEmbed({
      token: "token",
      owner: "owner",
      repo: "repo",
      slotId: "slot-abc",
    });

    expect(result.status).toBe("opened");
    expect(result.path).toBe("app/layout.tsx");
    expect(result.cspPaths).toContain("next.config.ts");

    const written = github.putFile.mock.calls.map((c) => c[0].path);
    expect(written).toContain("app/layout.tsx");
    expect(written).toContain("next.config.ts");
  });

  it("opens a CSP-only PR when the embed is already present", async () => {
    github.files.set(
      "app/layout.tsx",
      `export default function RootLayout({ children }) {\n  return <html><body>{children}<div data-cp-ad data-slot="slot-abc"></div></body></html>;\n}\n`,
    );
    github.files.set(
      "next.config.ts",
      `const csp = ["default-src 'self'", "script-src 'self'"].join('; ');\nexport default {};\n`,
    );

    const result = await installAdEmbed({
      token: "token",
      owner: "owner",
      repo: "repo",
      slotId: "slot-abc",
    });

    expect(result.status).toBe("opened");
    expect(result.cspPaths).toContain("next.config.ts");
    const written = github.putFile.mock.calls.map((c) => c[0].path);
    expect(written).not.toContain("app/layout.tsx");
    expect(written).toContain("next.config.ts");
  });

  it("installs every available size before </body> with a single loader", async () => {
    github.files.set(
      "app/layout.tsx",
      "export default function RootLayout({ children }) {\n  return <html><body>{children}</body></html>;\n}\n",
    );

    await installAdEmbed({
      token: "token",
      owner: "owner",
      repo: "repo",
      slotId: "slot-abc",
    });

    const write = github.putFile.mock.calls.find((c) => c[0].path === "app/layout.tsx");
    expect(write).toBeDefined();
    const content = write![0].contentUtf8 as string;
    // A unit for every publisher size…
    expect(content).toContain('data-format="banner_300x250"');
    expect(content).toContain('data-format="banner_728x90"');
    // …a single shared /ad.js loader for all of them…
    expect(content.match(/ad\.js/g)?.length).toBe(1);
    // …and everything lands above </body>.
    expect(content.indexOf("data-cp-ad")).toBeLessThan(content.indexOf("</body>"));
    expect(content.lastIndexOf("data-cp-ad")).toBeLessThan(content.indexOf("</body>"));
  });

  it("no-ops when the embed exists and no CSP needs changes", async () => {
    github.files.set(
      "app/layout.tsx",
      `export default function RootLayout({ children }) {\n  return <html><body>{children}<div data-cp-ad data-slot="slot-abc"></div></body></html>;\n}\n`,
    );

    const result = await installAdEmbed({
      token: "token",
      owner: "owner",
      repo: "repo",
      slotId: "slot-abc",
    });

    expect(result.status).toBe("noop");
    expect(github.openPullRequest).not.toHaveBeenCalled();
  });
});
