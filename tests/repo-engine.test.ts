// Repo Health engine: repo resolution, scoring, and graceful degradation.
//
// Every test drives the engine through an injected fetch, so nothing here
// touches github.com and the 90/180-day windows are pinned by `now`.

import { describe, expect, it } from "vitest";
import { parseRepoUrl, repoFromHtml, type RepoSignals } from "@/lib/audit/repo";
import { cadenceScore, scoreRepo, topAuthorShare } from "@/lib/audit/repo-score";
import { repoAudit, resolveRepo } from "@/lib/audit/repo-engine";

const NOW = Date.parse("2026-08-27T12:00:00Z");
const DAY = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

const WEEKLY_COMMITS = [1, 8, 15, 22, 29, 36, 43, 50, 57, 64, 71, 78].map(daysAgo);

function signals(over: Partial<RepoSignals> = {}): RepoSignals {
  return {
    ref: { owner: "profullstack", repo: "example" },
    source: "target-url",
    fullName: "profullstack/example",
    description: "An example project",
    homepage: "https://example.com",
    language: "TypeScript",
    topics: ["payments"],
    license: "MIT",
    archived: false,
    fork: false,
    createdAt: new Date(NOW - 400 * DAY).toISOString(),
    pushedAt: daysAgo(1),
    stars: 18,
    watchers: 0,
    forks: 19,
    hasDiscussions: false,
    // A commit in every one of the last 12 weeks — an active project's rhythm.
    commitDates: WEEKLY_COMMITS,
    commitAuthors: WEEKLY_COMMITS.map(() => "ralyodio"),
    commits90: WEEKLY_COMMITS.length,
    commits180: WEEKLY_COMMITS.length,
    lastCommitAt: daysAgo(1),
    contributors: 17,
    openIssues: 1,
    closedIssues: 90,
    totalPrs: 100,
    mergedPrs: 95,
    helpWantedOpen: 0,
    releases90: 8,
    latestReleaseAt: daysAgo(30),
    hasReadme: true,
    funded: false,
    notes: [],
    ...over,
  };
}

describe("parseRepoUrl", () => {
  it("pulls owner/repo out of repo URLs in any shape", () => {
    expect(parseRepoUrl("https://github.com/profullstack/coinpayportal")).toEqual({
      owner: "profullstack",
      repo: "coinpayportal",
    });
    expect(parseRepoUrl("github.com/profullstack/coinpayportal.git")).toEqual({
      owner: "profullstack",
      repo: "coinpayportal",
    });
    expect(parseRepoUrl("https://www.github.com/profullstack/coinpayportal/tree/master")).toEqual({
      owner: "profullstack",
      repo: "coinpayportal",
    });
  });

  it("rejects github paths that are not repositories", () => {
    expect(parseRepoUrl("https://github.com/profullstack")).toBeNull();
    expect(parseRepoUrl("https://github.com/sponsors/ralyodio")).toBeNull();
    expect(parseRepoUrl("https://github.com/orgs/profullstack/repositories")).toBeNull();
    expect(parseRepoUrl("https://example.com/profullstack/coinpayportal")).toBeNull();
  });
});

describe("repoFromHtml", () => {
  it("picks the most-linked repo, not the first one mentioned", () => {
    const html = `
      <a href="https://github.com/vercel/next.js">Built with Next.js</a>
      <a href="https://github.com/profullstack/coinpayportal">Source</a>
      <a href="https://github.com/profullstack/coinpayportal/issues">Issues</a>
      <footer><a href="https://github.com/profullstack/coinpayportal">Star us</a></footer>
    `;
    expect(repoFromHtml(html)).toEqual({ owner: "profullstack", repo: "coinpayportal" });
  });

  it("returns null when a site links to no repositories", () => {
    expect(repoFromHtml('<a href="https://github.com/profullstack">Our GitHub</a>')).toBeNull();
    expect(repoFromHtml("<p>no links here</p>")).toBeNull();
  });
});

describe("cadenceScore", () => {
  it("scores a steady rhythm above a single burst of the same size", () => {
    const steady = [0, 7, 14, 21, 28, 35].map(daysAgo);
    const burst = [0, 0.1, 0.2, 0.3, 0.4, 0.5].map(daysAgo);
    expect(cadenceScore(steady, NOW)!).toBeGreaterThan(cadenceScore(burst, NOW)!);
  });

  it("is null with no history", () => {
    expect(cadenceScore([], NOW)).toBeNull();
  });
});

describe("topAuthorShare", () => {
  it("measures the busiest author's share", () => {
    expect(topAuthorShare(["a", "a", "a", "b"])).toBeCloseTo(0.75);
    expect(topAuthorShare([])).toBeNull();
  });
});

describe("scoreRepo", () => {
  it("rates an active, well-resolved repo as Healthy", () => {
    const s = scoreRepo(signals(), NOW);
    expect(s.health).toBeGreaterThanOrEqual(80);
    expect(s.band).toBe("Healthy");
  });

  it("bands a dormant repo as At Risk", () => {
    const s = scoreRepo(
      signals({
        commitDates: [daysAgo(400)],
        commitAuthors: ["ralyodio"],
        commits90: 0,
        commits180: 0,
        lastCommitAt: daysAgo(400),
        closedIssues: 2,
        openIssues: 40,
        mergedPrs: 1,
        totalPrs: 30,
      }),
      NOW,
    );
    expect(s.band).toBe("At Risk");
    expect(s.health).toBeLessThan(40);
  });

  it("caps health for an archived repo however good its trailing numbers are", () => {
    expect(scoreRepo(signals({ archived: true }), NOW).health).toBeLessThanOrEqual(20);
  });

  it("scores the same work higher when fewer people are already watching", () => {
    const quiet = scoreRepo(signals({ stars: 18, watchers: 0 }), NOW).undervalued;
    const famous = scoreRepo(signals({ stars: 8000, watchers: 400 }), NOW).undervalued;
    expect(quiet).toBeGreaterThan(famous);
  });

  it("redistributes weight instead of punishing signals it could not read", () => {
    const full = scoreRepo(signals(), NOW);
    const partial = scoreRepo(
      signals({ openIssues: null, closedIssues: null, totalPrs: null, mergedPrs: null }),
      NOW,
    );
    // Issue and PR health were both strong, so dropping them should move the
    // score a little, not collapse it to the 0.60 the missing weight would
    // otherwise leave behind.
    expect(partial.health).toBeGreaterThan(full.health - 25);
    expect(partial.healthMissing).toContain("issue_health");
  });

  it("awards no maturity bonus inside the first six months", () => {
    const young = scoreRepo(signals({ createdAt: new Date(NOW - 30 * DAY).toISOString() }), NOW);
    expect(young.ageBonus).toBe(0);
  });

  it("tags a solo builder, a fork magnet, and a release machine", () => {
    const s = scoreRepo(
      signals({
        commitDates: [1, 2, 3, 4, 5, 6].map(daysAgo),
        commitAuthors: ["ralyodio", "ralyodio", "ralyodio", "ralyodio", "ralyodio", "someone"],
        commits180: 6,
      }),
      NOW,
    );
    expect(s.tags).toContain("solo_builder"); // 5/6 > 80%
    expect(s.tags).toContain("fork_magnet"); // 19 forks / 18 stars
    expect(s.tags).toContain("release_machine"); // 8 releases in 90d
    expect(s.tags).toContain("hidden_gem"); // <100 stars, active, documented
  });

  it("does not call two commits by one person a solo builder", () => {
    const s = scoreRepo(
      signals({ commitDates: [daysAgo(1), daysAgo(2)], commitAuthors: ["a", "a"], commits180: 2 }),
      NOW,
    );
    expect(s.tags).not.toContain("solo_builder");
  });
});

describe("resolveRepo", () => {
  const noFetch = (async () => {
    throw new Error("should not fetch");
  }) as unknown as typeof fetch;

  it("prefers a github target URL over everything else", async () => {
    const r = await resolveRepo("https://github.com/profullstack/coinpayportal", {
      projectRepos: [{ owner: "other", repo: "thing" }],
      fetchImpl: noFetch,
    });
    expect(r).toEqual({
      ref: { owner: "profullstack", repo: "coinpayportal" },
      source: "target-url",
    });
  });

  it("falls back to a repo bound to the project before crawling the site", async () => {
    const r = await resolveRepo("https://coinpayportal.com", {
      projectRepos: [{ owner: "profullstack", repo: "coinpayportal" }],
      fetchImpl: noFetch,
    });
    expect(r?.source).toBe("project-repo");
  });
});

// ---- Engine, end to end over a stub GitHub -------------------------------

function stubGithub(overrides: Record<string, unknown> = {}): typeof fetch {
  const repo = {
    full_name: "profullstack/coinpayportal",
    description: "A non-custodial payment gateway",
    homepage: "https://coinpayportal.com",
    language: "TypeScript",
    topics: ["payments"],
    license: { spdx_id: "MIT" },
    archived: false,
    fork: false,
    created_at: new Date(NOW - 400 * DAY).toISOString(),
    pushed_at: daysAgo(1),
    stargazers_count: 18,
    subscribers_count: 0,
    forks_count: 19,
    has_discussions: false,
    ...overrides,
  };

  return (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.endsWith("/repos/profullstack/coinpayportal")) return json(repo);
    if (url.includes("/commits")) {
      if (url.includes("page=1")) {
        return json([
          { commit: { author: { date: daysAgo(1), name: "Chovy" } }, author: { login: "ralyodio" } },
          { commit: { author: { date: daysAgo(9) } }, author: { login: "ralyodio" } },
        ]);
      }
      return json([]);
    }
    if (url.includes("/contributors")) return json([{}, {}, {}]);
    if (url.includes("/releases")) {
      return json([{ published_at: daysAgo(30), created_at: daysAgo(30), draft: false }]);
    }
    if (url.includes("/readme")) return json({ name: "README.md" });
    if (url.includes("FUNDING.yml")) return json({ message: "Not Found" }, 404);
    if (url.includes("/search/issues")) return json({ total_count: 12 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("repoAudit", () => {
  it("scores a repo reached straight from its github URL", async () => {
    const r = await repoAudit("https://github.com/profullstack/coinpayportal", {
      fetchImpl: stubGithub(),
      now: NOW,
      token: null,
    });

    expect(r.score).toBeGreaterThan(0);
    const keys = r.findings.map((f) => f.check_key);
    expect(keys).toContain("repo.health");
    expect(keys).toContain("repo.undervalued");
    expect(keys).toContain("repo.reach");
    expect(r.markdown).toContain("Repo Health — profullstack/coinpayportal");
    expect(r.summary.pagesCrawled).toBe(0);
  });

  it("reports the site link it followed, so a wrong guess is visible", async () => {
    const withSite = ((async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://coinpayportal.com/") {
        return new Response(
          '<a href="https://github.com/profullstack/coinpayportal">Source</a>',
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      return stubGithub()(input);
    }) as unknown) as typeof fetch;

    const r = await repoAudit("https://coinpayportal.com/", {
      fetchImpl: withSite,
      now: NOW,
      token: null,
    });
    const identified = r.findings.find((f) => f.check_key === "repo.identified");
    expect(identified?.detail).toContain("GitHub link on the site's homepage");
  });

  it("returns an honest unknown rather than a zero when there is no repo", async () => {
    const noRepo = (async () =>
      new Response("<p>nothing here</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

    const r = await repoAudit("https://example.com/", { fetchImpl: noRepo, now: NOW, token: null });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].status).toBe("unknown");
    expect(r.summary.unknown).toBe(1);
  });

  it("still scores when the search API is rate-limited, and says so", async () => {
    const limited = ((async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/search/issues")) {
        return new Response(JSON.stringify({ message: "rate limited" }), { status: 403 });
      }
      return stubGithub()(input);
    }) as unknown) as typeof fetch;

    const r = await repoAudit("https://github.com/profullstack/coinpayportal", {
      fetchImpl: limited,
      now: NOW,
      token: null,
    });
    expect(r.score).toBeGreaterThan(0);
    const notes = r.findings.find((f) => f.check_key === "repo.collection_notes");
    expect(notes?.detail).toContain("Search unavailable");
  });

  it("surfaces a private or missing repository as an error, not a bad score", async () => {
    const missing = (async () =>
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as unknown as typeof fetch;

    await expect(
      repoAudit("https://github.com/profullstack/nope", {
        fetchImpl: missing,
        now: NOW,
        token: null,
      }),
    ).rejects.toThrow(/not found, or it is private/i);
  });
});
