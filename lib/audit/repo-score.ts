// Scoring for the Repo Health engine. Pure: takes collected signals, returns
// numbers. No network, no clock of its own — `now` is passed in so a score is
// reproducible from a stored RepoSignals snapshot.
//
// Two scores, deliberately answering different questions:
//
//   Health (0-100)      Is this project alive and maintained right now?
//   Undervalued (0-100) Is the work outrunning the attention it gets?
//
// The second is the interesting one. Stars are a lagging indicator — they
// measure yesterday's attention — so we measure the building (commits,
// contributors, issue resolution, fork utility, releases) and divide by a
// logarithmic reach factor. A repo with eight stars and daily commits scores
// above one coasting on eight thousand.
//
// Any component we could not read (a search rate limit, a 404) is dropped and
// its weight redistributed across the components we did read, so a partial
// collection produces a fair score rather than a punished one.

import { isBotAuthor, type RepoSignals } from "./repo";

const DAY_MS = 86_400_000;

export type HealthBand = "Healthy" | "Stable" | "Quiet" | "At Risk";

export type RepoTag =
  | "solo_builder"
  | "needs_contributors"
  | "hidden_gem"
  | "legacy_hero"
  | "fork_magnet"
  | "release_machine"
  | "under_pressure"
  | "community_watch"
  | "community_hub"
  | "funded";

export const TAG_LABELS: Record<RepoTag, string> = {
  solo_builder: "solo builder",
  needs_contributors: "needs contributors",
  hidden_gem: "hidden gem",
  legacy_hero: "legacy hero",
  fork_magnet: "fork magnet",
  release_machine: "release machine",
  under_pressure: "under pressure",
  community_watch: "community watch",
  community_hub: "community hub",
  funded: "funded",
};

export const TAG_MEANINGS: Record<RepoTag, string> = {
  solo_builder: "One person holds more than 80% of commits in the last 180 days.",
  needs_contributors: 'Has open "help wanted" or "good first issue" labels.',
  hidden_gem: "Under 100 stars, active in the last 3 months, and documented.",
  legacy_hero: "More than 5 years old and still committed to this year.",
  fork_magnet: "Forks are over half the star count — used as a template or dependency.",
  release_machine: "Five or more releases in the last 90 days.",
  under_pressure: "More than 10 open issues carried by 2 or fewer contributors.",
  community_watch: "More watchers than stars — developers tracking it before the public.",
  community_hub: "GitHub Discussions is enabled.",
  funded: "The maintainer has an active funding channel.",
};

/** One weighted input to a score. A null value means "could not read". */
interface Component {
  key: string;
  label: string;
  weight: number;
  value: number | null;
  /** Human-readable basis, for the report. */
  detail: string;
}

interface WeightedResult {
  /** 0-1, weights renormalised over the components that had values. */
  value: number;
  components: Component[];
  /** Components dropped because they could not be read. */
  missing: string[];
}

function combine(components: Component[]): WeightedResult {
  const present = components.filter((c) => c.value !== null);
  const missing = components.filter((c) => c.value === null).map((c) => c.key);
  const totalWeight = present.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) return { value: 0, components, missing };
  const value = present.reduce((sum, c) => sum + c.weight * (c.value as number), 0) / totalWeight;
  return { value, components, missing };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function ratio(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null) return null;
  if (whole <= 0) return null;
  return clamp01(part / whole);
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now - t) / DAY_MS;
}

/**
 * Weeks of rhythm we can fairly judge: twelve, or the repo's whole life if it
 * is younger than that.
 *
 * A repository created two weeks ago cannot have committed in week eleven, and
 * scoring it as though it failed to is how a brand-new project with 185
 * commits lands in the "Quiet" band.
 */
export function cadenceWindow(createdAt: string, now: number): number {
  const age = (now - Date.parse(createdAt)) / (7 * DAY_MS);
  if (!Number.isFinite(age)) return 12;
  return Math.max(1, Math.min(12, Math.ceil(age)));
}

/**
 * Commit rhythm: the share of the observed weeks that saw at least one commit.
 *
 * Deliberately not commit *count* — a hundred commits in one weekend and
 * nothing since is a burst, not a rhythm, and this scores it as one.
 */
export function cadenceScore(
  commitDates: string[],
  now: number,
  window = 12,
): number | null {
  if (commitDates.length === 0) return null;
  const weeks = new Set<number>();
  for (const d of commitDates) {
    const t = Date.parse(d);
    if (Number.isNaN(t)) continue;
    const weeksAgo = Math.floor((now - t) / (7 * DAY_MS));
    if (weeksAgo >= 0 && weeksAgo < window) weeks.add(weeksAgo);
  }
  return weeks.size / window;
}

/** Bots are dropped before any contributor signal is computed. */
export function humanAuthors(authors: string[]): string[] {
  return authors.filter((a) => !isBotAuthor(a));
}

/** Share of 180-day commits held by the single busiest human author. */
export function topAuthorShare(authors: string[]): number | null {
  const people = humanAuthors(authors);
  if (people.length === 0) return null;
  const counts = new Map<string, number>();
  for (const a of people) counts.set(a, (counts.get(a) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return top / people.length;
}

export function uniqueAuthors(authors: string[]): number {
  return new Set(humanAuthors(authors)).size;
}

export function healthBand(health: number): HealthBand {
  if (health >= 80) return "Healthy";
  if (health >= 60) return "Stable";
  if (health >= 40) return "Quiet";
  return "At Risk";
}

export const BAND_MEANINGS: Record<HealthBand, string> = {
  Healthy: "Active, responsive, regular releases.",
  Stable: "Maintained, steady, no alarms.",
  Quiet: "Slowing down — worth watching.",
  "At Risk": "Going dark — a candidate for rescue.",
};

export interface RepoScore {
  health: number;
  band: HealthBand;
  healthComponents: Component[];
  healthMissing: string[];

  undervalued: number;
  /** The un-divided signal, 0 to ~1.3. Useful for explaining the score. */
  signal: number;
  /** log10(stars + watchers + 10). */
  reach: number;
  signalComponents: Component[];
  signalMissing: string[];
  ageBonus: number;
  homepageBonus: number;

  tags: RepoTag[];
  ageMonths: number;
  daysSinceCommit: number | null;
}

export function scoreRepo(s: RepoSignals, now: number = Date.now()): RepoScore {
  const daysSinceCommit = daysSince(s.lastCommitAt, now);
  const ageMonths = Math.max(0, (now - Date.parse(s.createdAt)) / (30.44 * DAY_MS));

  const issueResolution = ratio(
    s.closedIssues,
    s.closedIssues === null || s.openIssues === null ? null : s.closedIssues + s.openIssues,
  );
  const prHealth = ratio(s.mergedPrs, s.totalPrs);

  // ---- Health -------------------------------------------------------------
  const recency = daysSinceCommit === null ? null : clamp01(1 - daysSinceCommit / 90);
  const window = cadenceWindow(s.createdAt, now);
  const cadence = cadenceScore(s.commitDates, now, window);

  const health = combine([
    {
      key: "recency",
      label: "Commit recency",
      weight: 0.35,
      value: recency,
      detail:
        daysSinceCommit === null
          ? "No commit history available."
          : `Last commit ${Math.round(daysSinceCommit)} day(s) ago (decays to zero at 90).`,
    },
    {
      key: "cadence",
      label: "Commit rhythm",
      weight: 0.25,
      value: cadence,
      detail:
        cadence === null
          ? "No commit history available."
          : `${Math.round(cadence * window)} of the last ${window} week(s) had at least one commit${
              window < 12 ? " (the repo is younger than the 12-week window)" : ""
            }.`,
    },
    {
      key: "issue_health",
      label: "Issue resolution",
      weight: 0.2,
      value: issueResolution,
      detail:
        issueResolution === null
          ? "Issue counts unavailable."
          : `${s.closedIssues} closed of ${(s.closedIssues ?? 0) + (s.openIssues ?? 0)} issues.`,
    },
    {
      key: "pr_health",
      label: "Pull request merge rate",
      weight: 0.2,
      value: prHealth,
      detail:
        prHealth === null
          ? "Pull request counts unavailable."
          : `${s.mergedPrs} merged of ${s.totalPrs} pull requests.`,
    },
  ]);

  // An archived repo is not being maintained, whatever its trailing numbers say.
  const healthValue = s.archived ? Math.min(health.value, 0.2) : health.value;
  const healthScore = Math.round(clamp01(healthValue) * 100);

  // ---- Undervalued --------------------------------------------------------
  const commitVelocity = clamp01(Math.min(s.commits90, 30) / 30);
  const authors = uniqueAuthors(s.commitAuthors);
  const contributorWork = clamp01(Math.min(authors * s.commits90, 100) / 100);
  const forkRatio = s.stars > 0 ? clamp01(s.forks / s.stars) : s.forks > 0 ? 1 : 0;
  const releaseCadence = s.releases90 === null ? null : clamp01(Math.min(s.releases90, 3) / 3);

  const signalParts = combine([
    {
      key: "commit_velocity",
      label: "Commit velocity",
      weight: 0.25,
      value: commitVelocity,
      detail: `${s.commits90} commit(s) in the last 90 days (capped at 30).`,
    },
    {
      key: "contributor_work",
      label: "Contributor work",
      weight: 0.2,
      value: contributorWork,
      detail: `${authors} author(s) × ${s.commits90} commits (capped at 100).`,
    },
    {
      key: "issue_resolution",
      label: "Issue resolution",
      weight: 0.2,
      value: issueResolution,
      detail:
        issueResolution === null
          ? "Issue counts unavailable."
          : `${s.closedIssues} closed of ${(s.closedIssues ?? 0) + (s.openIssues ?? 0)} issues.`,
    },
    {
      key: "fork_ratio",
      label: "Fork utility",
      weight: 0.2,
      value: forkRatio,
      detail: `${s.forks} fork(s) against ${s.stars} star(s) — a proxy for real use.`,
    },
    {
      key: "release_cadence",
      label: "Release cadence",
      weight: 0.1,
      value: releaseCadence,
      detail:
        releaseCadence === null
          ? "Releases unavailable."
          : `${s.releases90} release(s) in the last 90 days (capped at 3).`,
    },
  ]);

  // The weighted block is worth 0.95; bonuses sit on top of it, as in the
  // published formula (0.25 + 0.20 + 0.20 + 0.20 + 0.10).
  const weightedSignal = signalParts.value * 0.95;

  // Maturity: nothing for the first six months, ramping to the full +0.30 at
  // three years. A brand-new repo has not yet earned the benefit of the doubt.
  const ageBonus = ageMonths <= 6 ? 0 : Math.min(0.3, (0.3 * (ageMonths - 6)) / 30);
  const homepageBonus = s.homepage ? 0.05 : 0;

  const signal = weightedSignal + ageBonus + homepageBonus;
  const reach = Math.log10(s.stars + s.watchers + 10);
  const undervalued = Math.round(Math.max(0, Math.min(100, (signal / reach) * 100)));

  // ---- Tags ---------------------------------------------------------------
  const share = topAuthorShare(s.commitAuthors);
  const activeRecently = daysSinceCommit !== null && daysSinceCommit <= 90;
  const committedThisYear =
    s.lastCommitAt !== null &&
    new Date(s.lastCommitAt).getUTCFullYear() === new Date(now).getUTCFullYear();

  const tags: RepoTag[] = [];
  // Guard the share against tiny samples: 2 commits by one person is not a
  // finding about how the project is run.
  if (share !== null && share > 0.8 && s.commits180 >= 5) tags.push("solo_builder");
  if ((s.helpWantedOpen ?? 0) > 0) tags.push("needs_contributors");
  if (s.stars < 100 && activeRecently && (s.hasReadme === true || !!s.description)) {
    tags.push("hidden_gem");
  }
  if (ageMonths > 60 && committedThisYear) tags.push("legacy_hero");
  if (s.stars > 0 && s.forks / s.stars > 0.5) tags.push("fork_magnet");
  if ((s.releases90 ?? 0) >= 5) tags.push("release_machine");
  if (
    (s.openIssues ?? 0) > 10 &&
    s.contributors !== null &&
    s.contributors <= 2 &&
    healthScore >= 60
  ) {
    tags.push("under_pressure");
  }
  if (s.watchers > s.stars) tags.push("community_watch");
  if (s.hasDiscussions) tags.push("community_hub");
  if (s.funded === true) tags.push("funded");

  return {
    health: healthScore,
    band: healthBand(healthScore),
    healthComponents: health.components,
    healthMissing: health.missing,
    undervalued,
    signal,
    reach,
    signalComponents: signalParts.components,
    signalMissing: signalParts.missing,
    ageBonus,
    homepageBonus,
    tags,
    ageMonths,
    daysSinceCommit,
  };
}
