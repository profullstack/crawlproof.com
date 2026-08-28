// GitHub repository signal collection for the Repo Health engine.
//
// Deterministic and dependency-free: every number here comes from the public
// REST API, so the engine can score a repo with no LLM and no key. The scoring
// itself lives in repo-engine.ts — this module only resolves *which* repo we
// are looking at and gathers the raw counts.
//
// Auth is best-effort, in three tiers:
//   1. a GitHub App installation token (when the project has a bound repo),
//   2. GITHUB_TOKEN / GH_TOKEN from the environment,
//   3. nothing at all — 60 requests/hour, enough for occasional scans.
// A collection that runs short of budget degrades to partial signals rather
// than failing the scan: every field we could not read comes back null and the
// scoring redistributes its weight.

const GH_API = "https://api.github.com";

/** Pages of 100 commits to read over the 180-day window. */
const COMMIT_PAGES = 10;

/**
 * Automated committers, excluded from contributor signals.
 *
 * Dependabot opening 17 pull requests is maintenance the robot did, not
 * contributor effort, and counting it dilutes the one measure that says
 * whether a project rests on a single pair of hands.
 */
export function isBotAuthor(login: string): boolean {
  const l = login.toLowerCase();
  return (
    l.endsWith("[bot]") ||
    l === "dependabot" ||
    l === "renovate" ||
    l === "github-actions" ||
    l === "unknown"
  );
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface RepoSignals {
  ref: RepoRef;
  /** How we found this repo — surfaced in the report so the user can correct it. */
  source: "target-url" | "project-repo" | "site-link";

  // ---- Repository metadata ------------------------------------------------
  fullName: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  topics: string[];
  license: string | null;
  archived: boolean;
  fork: boolean;
  createdAt: string;
  pushedAt: string | null;
  stars: number;
  /** True watchers. REST's `watchers_count` is an alias for the star count; the
   *  number of people actually subscribed to the repo is `subscribers_count`. */
  watchers: number;
  forks: number;
  hasDiscussions: boolean;

  // ---- Activity -----------------------------------------------------------
  /** ISO timestamps of commits in the last 180 days, newest first. */
  commitDates: string[];
  /** Author login per commit (falling back to the commit author's name for
   *  unattributed commits), index-aligned with commitDates. */
  commitAuthors: string[];
  commits90: number;
  commits180: number;
  lastCommitAt: string | null;
  contributors: number | null;

  // ---- Issues and pull requests -------------------------------------------
  openIssues: number | null;
  closedIssues: number | null;
  totalPrs: number | null;
  mergedPrs: number | null;
  helpWantedOpen: number | null;

  // ---- Releases -----------------------------------------------------------
  releases90: number | null;
  latestReleaseAt: string | null;

  // ---- Documentation and funding ------------------------------------------
  hasReadme: boolean | null;
  funded: boolean | null;

  /** Non-fatal problems (rate limits, 404s on optional endpoints). */
  notes: string[];
}

// github.com paths that look like /owner/repo but are not repositories.
const NON_REPO_OWNERS = new Set([
  "sponsors",
  "orgs",
  "features",
  "topics",
  "collections",
  "events",
  "marketplace",
  "apps",
  "settings",
  "explore",
  "readme",
  "about",
  "pricing",
  "security",
  "site",
  "login",
  "join",
  "notifications",
  "search",
  "enterprise",
  "customer-stories",
]);

const NON_REPO_NAMES = new Set(["issues", "pulls", "discussions", "releases", "wiki", "actions"]);

/** Parse `github.com/owner/repo` out of any URL-ish string. */
export function parseRepoUrl(input: string): RepoRef | null {
  let url: URL;
  try {
    url = new URL(input.startsWith("http") ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (NON_REPO_OWNERS.has(owner.toLowerCase())) return null;
  if (NON_REPO_NAMES.has(repo.toLowerCase())) return null;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/**
 * Find the repository a website belongs to by reading its homepage.
 *
 * Sites link to GitHub from a header, a footer, or a "star us" badge, and
 * often to several repos at once. We take the most-linked one, which in
 * practice is the project's own repo rather than a dependency it credits.
 */
export async function discoverRepoFromSite(
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepoRef | null> {
  let html: string;
  try {
    const res = await fetchImpl(target, {
      headers: { "User-Agent": "CrawlProof/1.0", Accept: "text/html" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }
  return repoFromHtml(html);
}

/** Pure half of discoverRepoFromSite, so it can be tested without a network. */
export function repoFromHtml(html: string): RepoRef | null {
  const counts = new Map<string, { ref: RepoRef; n: number }>();
  const re = /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+/gi;
  for (const match of html.matchAll(re)) {
    const ref = parseRepoUrl(match[0]);
    if (!ref) continue;
    const key = `${ref.owner}/${ref.repo}`.toLowerCase();
    const seen = counts.get(key);
    if (seen) seen.n += 1;
    else counts.set(key, { ref, n: 1 });
  }
  if (counts.size === 0) return null;
  return [...counts.values()].sort((a, b) => b.n - a.n)[0].ref;
}

function authHeaders(token?: string | null): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "CrawlProof/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

interface GhResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
  link: string | null;
}

async function gh<T>(
  path: string,
  token: string | null | undefined,
  fetchImpl: typeof fetch,
): Promise<GhResult<T>> {
  try {
    const res = await fetchImpl(`${GH_API}${path}`, { headers: authHeaders(token) });
    const link = res.headers.get("link");
    if (!res.ok) return { ok: false, status: res.status, body: null, link };
    return { ok: true, status: res.status, body: (await res.json()) as T, link };
  } catch {
    return { ok: false, status: 0, body: null, link: null };
  }
}

interface GhRepoResponse {
  full_name: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  topics?: string[];
  license: { spdx_id?: string; name?: string } | null;
  archived: boolean;
  fork: boolean;
  created_at: string;
  pushed_at: string | null;
  stargazers_count: number;
  subscribers_count: number;
  forks_count: number;
  has_discussions?: boolean;
}

interface GhCommit {
  commit: { author: { date: string; name?: string } | null };
  author: { login: string } | null;
}

interface GhRelease {
  published_at: string | null;
  created_at: string;
  draft: boolean;
}

interface GhSearchResponse {
  total_count: number;
}

function daysAgoIso(days: number, now: number): string {
  return new Date(now - days * 86_400_000).toISOString();
}

/** Search counts sit under a separate, much tighter rate limit — 30/min with a
 *  token, 10/min without. Every call is optional: null drops that component. */
async function searchCount(
  query: string,
  token: string | null | undefined,
  fetchImpl: typeof fetch,
  notes: string[],
): Promise<number | null> {
  const res = await gh<GhSearchResponse>(
    `/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
    token,
    fetchImpl,
  );
  if (!res.ok || !res.body) {
    notes.push(`Search unavailable (HTTP ${res.status}) for: ${query}`);
    return null;
  }
  return res.body.total_count;
}

export interface CollectOptions {
  token?: string | null;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so the 90/180-day windows are deterministic. */
  now?: number;
}

/**
 * Read every signal the scoring needs. Throws only when the repository itself
 * cannot be read (404 / private / rate-limited on the very first call); every
 * other endpoint degrades to null.
 */
export async function collectRepoSignals(
  ref: RepoRef,
  source: RepoSignals["source"],
  options: CollectOptions = {},
): Promise<RepoSignals> {
  const { token, fetchImpl = fetch, now = Date.now() } = options;
  const notes: string[] = [];
  const slug = `${ref.owner}/${ref.repo}`;

  const repoRes = await gh<GhRepoResponse>(`/repos/${slug}`, token, fetchImpl);
  if (!repoRes.ok || !repoRes.body) {
    if (repoRes.status === 404) throw new Error(`Repository ${slug} not found, or it is private.`);
    if (repoRes.status === 403 || repoRes.status === 429) {
      throw new Error(
        `GitHub rate limit reached while reading ${slug}. Set GITHUB_TOKEN to raise the limit.`,
      );
    }
    throw new Error(`Could not read ${slug} from GitHub (HTTP ${repoRes.status}).`);
  }
  const r = repoRes.body;

  const since180 = daysAgoIso(180, now);
  const cutoff90 = now - 90 * 86_400_000;

  // Commits: up to 1000 over 180 days. The cap has to clear a busy repo's real
  // volume, because author *share* is measured on whatever we collect — a
  // 300-commit cut of a 600-commit half-year silently understates the lead
  // author and loses the solo-builder signal entirely.
  const commitDates: string[] = [];
  const commitAuthors: string[] = [];
  let truncated = false;
  for (let page = 1; page <= COMMIT_PAGES; page++) {
    const res = await gh<GhCommit[]>(
      `/repos/${slug}/commits?since=${since180}&per_page=100&page=${page}`,
      token,
      fetchImpl,
    );
    if (!res.ok || !res.body) {
      if (page === 1) notes.push(`Commit history unavailable (HTTP ${res.status}).`);
      break;
    }
    for (const c of res.body) {
      const date = c.commit?.author?.date;
      if (!date) continue;
      commitDates.push(date);
      commitAuthors.push(c.author?.login ?? c.commit?.author?.name ?? "unknown");
    }
    if (res.body.length < 100) break;
    if (page === COMMIT_PAGES) truncated = true;
  }
  if (truncated) {
    notes.push(
      `Commit history truncated at ${COMMIT_PAGES * 100}; velocity and author share are measured on that slice.`,
    );
  }

  const commits90 = commitDates.filter((d) => Date.parse(d) >= cutoff90).length;

  const [contributorsRes, releasesRes, readmeRes, fundingRes] = await Promise.all([
    gh<unknown[]>(`/repos/${slug}/contributors?per_page=100&anon=1`, token, fetchImpl),
    gh<GhRelease[]>(`/repos/${slug}/releases?per_page=100`, token, fetchImpl),
    gh<unknown>(`/repos/${slug}/readme`, token, fetchImpl),
    gh<unknown>(`/repos/${slug}/contents/.github/FUNDING.yml`, token, fetchImpl),
  ]);

  let contributors: number | null = null;
  if (contributorsRes.ok && contributorsRes.body) {
    // The contributors endpoint caps at 500 and paginates; when a `last` page
    // link is present we report the first-page count as a floor rather than
    // paging through it, and say so.
    contributors = contributorsRes.body.length;
    if (contributorsRes.link?.includes('rel="last"')) {
      notes.push(`Contributor count is a floor of ${contributors} (the list is paginated).`);
    }
  } else {
    notes.push(`Contributor list unavailable (HTTP ${contributorsRes.status}).`);
  }

  let releases90: number | null = null;
  let latestReleaseAt: string | null = null;
  if (releasesRes.ok && releasesRes.body) {
    const published = releasesRes.body
      .filter((rel) => !rel.draft)
      .map((rel) => rel.published_at ?? rel.created_at)
      .filter((d): d is string => !!d)
      .sort((a, b) => Date.parse(b) - Date.parse(a));
    releases90 = published.filter((d) => Date.parse(d) >= cutoff90).length;
    latestReleaseAt = published[0] ?? null;
  } else {
    notes.push(`Releases unavailable (HTTP ${releasesRes.status}).`);
  }

  const openIssues = await searchCount(
    `repo:${slug} type:issue state:open`,
    token,
    fetchImpl,
    notes,
  );
  const closedIssues = await searchCount(
    `repo:${slug} type:issue state:closed`,
    token,
    fetchImpl,
    notes,
  );
  const totalPrs = await searchCount(`repo:${slug} type:pr`, token, fetchImpl, notes);
  const mergedPrs = await searchCount(`repo:${slug} type:pr is:merged`, token, fetchImpl, notes);
  // Deliberately the core issues endpoint, not search: the tag only needs to
  // know whether any labelled entry point exists, and search runs on a much
  // tighter budget (30/min with a token) that a run of several repos exhausts.
  //
  // One request per label, because `labels=` is an AND filter — asking for
  // both in one call matches only issues carrying both, which is nearly none.
  const helpWantedResults = await Promise.all(
    ["help wanted", "good first issue"].map((label) =>
      gh<unknown[]>(
        `/repos/${slug}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`,
        token,
        fetchImpl,
      ),
    ),
  );
  const helpWantedOpen = helpWantedResults.some((res) => res.ok)
    ? helpWantedResults.reduce((n, res) => n + (res.ok && res.body ? res.body.length : 0), 0)
    : null;

  return {
    ref,
    source,
    fullName: r.full_name,
    description: r.description,
    homepage: r.homepage && r.homepage.trim() ? r.homepage.trim() : null,
    language: r.language,
    topics: r.topics ?? [],
    license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null,
    archived: r.archived,
    fork: r.fork,
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
    stars: r.stargazers_count,
    watchers: r.subscribers_count,
    forks: r.forks_count,
    hasDiscussions: !!r.has_discussions,
    commitDates,
    commitAuthors,
    commits90,
    commits180: commitDates.length,
    lastCommitAt: commitDates[0] ?? r.pushed_at,
    contributors,
    openIssues,
    closedIssues,
    totalPrs,
    mergedPrs,
    helpWantedOpen,
    releases90,
    latestReleaseAt,
    hasReadme: readmeRes.status === 0 ? null : readmeRes.ok,
    funded: fundingRes.status === 0 ? null : fundingRes.ok,
    notes,
  };
}
