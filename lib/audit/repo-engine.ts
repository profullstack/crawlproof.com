// The "Repo Health" scan engine.
//
// Every other engine scores the *site*. This one scores the project behind it:
// is the repository alive and maintained, and is the work outrunning the
// attention it gets? Free and deterministic — no LLM, and no key required,
// though a token raises GitHub's rate limit.
//
// Resolving which repo to score, in order of confidence:
//   1. the scan target itself, when it is a github.com/owner/repo URL,
//   2. a repo already bound to the project (project_repos — the same binding
//      the tracker installer and the Vu1nz engine use),
//   3. the most-linked GitHub repo on the site's homepage.
// Discovery is reported as a finding, so a wrong guess is visible and
// correctable rather than silent.

import { scoreRepo, BAND_MEANINGS, TAG_LABELS, TAG_MEANINGS, type RepoScore } from "./repo-score";
import {
  collectRepoSignals,
  discoverRepoFromSite,
  parseRepoUrl,
  type RepoRef,
  type RepoSignals,
} from "./repo";
import type { AuditResult, Finding } from "./types";

type RepoAuditResult = AuditResult & { markdown: string };

export interface RepoAuditOptions {
  /** GitHub App installation token or PAT. Falls back to GITHUB_TOKEN / GH_TOKEN. */
  token?: string | null;
  /** Repos already bound to the project, most recent first. */
  projectRepos?: RepoRef[];
  fetchImpl?: typeof fetch;
  now?: number;
}

const SOURCE_LABEL: Record<RepoSignals["source"], string> = {
  "target-url": "the scan target URL",
  "project-repo": "a repository connected to this project",
  "site-link": "a GitHub link on the site's homepage",
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  return new Date(t).toISOString().slice(0, 10);
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const days = Math.round((now - Date.parse(iso)) / 86_400_000);
  if (Number.isNaN(days)) return "unknown";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.round(months / 12)} years ago`;
}

/** Bands map onto finding statuses: a healthy repo passes, a dark one fails. */
function statusForScore(score: number): Finding["status"] {
  if (score >= 80) return "pass";
  if (score >= 40) return "warn";
  return "fail";
}

/**
 * Resolve the repository to score. Returns null when the site has no
 * discoverable GitHub presence — that is a legitimate outcome, not an error.
 */
export async function resolveRepo(
  target: string,
  options: RepoAuditOptions,
): Promise<{ ref: RepoRef; source: RepoSignals["source"] } | null> {
  const direct = parseRepoUrl(target);
  if (direct) return { ref: direct, source: "target-url" };

  const bound = options.projectRepos?.[0];
  if (bound) return { ref: bound, source: "project-repo" };

  const discovered = await discoverRepoFromSite(target, options.fetchImpl ?? fetch);
  if (discovered) return { ref: discovered, source: "site-link" };

  return null;
}

function buildFindings(s: RepoSignals, score: RepoScore, now: number): Finding[] {
  const findings: Finding[] = [];
  const slug = s.fullName;

  // ---- Discovery ----------------------------------------------------------
  findings.push({
    section: "Repository",
    check_key: "repo.identified",
    status: "pass",
    title: `Scoring ${slug}`,
    detail: `Found via ${SOURCE_LABEL[s.source]}. If that is the wrong repository, connect the right one to this project and re-run.`,
    evidence: {
      full_name: slug,
      url: `https://github.com/${slug}`,
      source: s.source,
      description: s.description,
      language: s.language,
      topics: s.topics,
      created_at: s.createdAt,
    },
    priority: 5,
  });

  // ---- The two scores -----------------------------------------------------
  findings.push({
    section: "Repo Signal",
    check_key: "repo.health",
    status: statusForScore(score.health),
    title: `Health ${score.health}/100 — ${score.band}`,
    detail: `${BAND_MEANINGS[score.band]}\n\n${score.healthComponents
      .map((c) => `· ${c.label}: ${c.value === null ? "unavailable" : pct(c.value)} — ${c.detail}`)
      .join("\n")}`,
    evidence: {
      health: score.health,
      band: score.band,
      components: score.healthComponents,
      missing: score.healthMissing,
    },
    priority: score.health >= 60 ? 4 : 2,
  });

  findings.push({
    section: "Repo Signal",
    check_key: "repo.undervalued",
    status: score.undervalued >= 50 ? "pass" : "warn",
    title: `Undervalued score ${score.undervalued}/100`,
    detail: [
      score.undervalued >= 50
        ? "Above 50: the work is outrunning the audience. This project is doing more than its star count suggests."
        : "Below 50: the attention this project has already earned is ahead of its current output.",
      "",
      `signal ${score.signal.toFixed(3)} ÷ reach ${score.reach.toFixed(3)} (log₁₀ of ${s.stars} stars + ${s.watchers} watchers + 10)`,
      "",
      ...score.signalComponents.map(
        (c) => `· ${c.label} (${c.weight.toFixed(2)}): ${c.value === null ? "unavailable" : pct(c.value)} — ${c.detail}`,
      ),
      `· Maturity bonus: +${score.ageBonus.toFixed(2)} (${Math.round(score.ageMonths)} months old)`,
      `· Homepage bonus: +${score.homepageBonus.toFixed(2)}${s.homepage ? ` (${s.homepage})` : " — no homepage set on the repo"}`,
    ].join("\n"),
    evidence: {
      undervalued: score.undervalued,
      signal: score.signal,
      reach: score.reach,
      components: score.signalComponents,
      missing: score.signalMissing,
      age_bonus: score.ageBonus,
      homepage_bonus: score.homepageBonus,
    },
    priority: 3,
  });

  // ---- Activity -----------------------------------------------------------
  const recency = score.healthComponents.find((c) => c.key === "recency");
  findings.push({
    section: "Activity",
    check_key: "repo.commit_recency",
    status:
      score.daysSinceCommit === null
        ? "unknown"
        : score.daysSinceCommit <= 30
          ? "pass"
          : score.daysSinceCommit <= 90
            ? "warn"
            : "fail",
    title:
      score.daysSinceCommit === null
        ? "Commit history unavailable"
        : `Last commit ${ago(s.lastCommitAt, now)}`,
    detail: recency?.detail,
    evidence: { last_commit_at: s.lastCommitAt, days_since: score.daysSinceCommit },
    priority: score.daysSinceCommit !== null && score.daysSinceCommit > 90 ? 2 : 4,
  });

  const cadence = score.healthComponents.find((c) => c.key === "cadence");
  findings.push({
    section: "Activity",
    check_key: "repo.commit_cadence",
    status:
      cadence?.value === null || cadence?.value === undefined
        ? "unknown"
        : cadence.value >= 0.5
          ? "pass"
          : cadence.value >= 0.25
            ? "warn"
            : "fail",
    title: `Commit rhythm across the last 12 weeks`,
    detail: `${cadence?.detail ?? "No commit history available."} A steady rhythm scores higher than the same number of commits landed in one burst.`,
    evidence: { commits_90d: s.commits90, commits_180d: s.commits180, cadence: cadence?.value },
    priority: 4,
  });

  findings.push({
    section: "Activity",
    check_key: "repo.releases",
    status: s.releases90 === null ? "unknown" : s.releases90 > 0 ? "pass" : "warn",
    title:
      s.releases90 === null
        ? "Release history unavailable"
        : `${s.releases90} release(s) in the last 90 days`,
    detail:
      s.latestReleaseAt === null
        ? "No published releases. Tagged releases give users something to pin to and are a strong maintenance signal."
        : `Latest release ${ago(s.latestReleaseAt, now)} (${fmtDate(s.latestReleaseAt)}).`,
    evidence: { releases_90d: s.releases90, latest_release_at: s.latestReleaseAt },
    priority: 4,
  });

  // ---- Maintenance --------------------------------------------------------
  const issueHealth = score.healthComponents.find((c) => c.key === "issue_health");
  findings.push({
    section: "Maintenance",
    check_key: "repo.issue_resolution",
    status:
      issueHealth?.value === null || issueHealth?.value === undefined
        ? "unknown"
        : issueHealth.value >= 0.7
          ? "pass"
          : issueHealth.value >= 0.4
            ? "warn"
            : "fail",
    title:
      s.openIssues === null
        ? "Issue counts unavailable"
        : `${s.openIssues} open / ${s.closedIssues} closed issues`,
    detail: issueHealth?.detail,
    evidence: { open_issues: s.openIssues, closed_issues: s.closedIssues },
    priority: 3,
  });

  const prHealth = score.healthComponents.find((c) => c.key === "pr_health");
  findings.push({
    section: "Maintenance",
    check_key: "repo.pr_merge_rate",
    status:
      prHealth?.value === null || prHealth?.value === undefined
        ? "unknown"
        : prHealth.value >= 0.6
          ? "pass"
          : prHealth.value >= 0.3
            ? "warn"
            : "fail",
    title:
      s.totalPrs === null
        ? "Pull request counts unavailable"
        : `${s.mergedPrs} of ${s.totalPrs} pull requests merged`,
    detail: prHealth?.detail,
    evidence: { merged_prs: s.mergedPrs, total_prs: s.totalPrs },
    priority: 3,
  });

  if (s.archived) {
    findings.push({
      section: "Maintenance",
      check_key: "repo.archived",
      status: "fail",
      title: "Repository is archived",
      detail:
        "GitHub reports this repository as archived — it is read-only and will not accept issues or pull requests. Health is capped accordingly.",
      evidence: { archived: true },
      priority: 1,
    });
  }

  findings.push({
    section: "Maintenance",
    check_key: "repo.license",
    status: s.license ? "pass" : "warn",
    title: s.license ? `Licensed under ${s.license}` : "No license detected",
    detail: s.license
      ? undefined
      : "Without a license the default is all-rights-reserved, which blocks adoption by anyone with a legal review.",
    evidence: { license: s.license },
    priority: s.license ? 5 : 3,
  });

  findings.push({
    section: "Maintenance",
    check_key: "repo.readme",
    status: s.hasReadme === null ? "unknown" : s.hasReadme ? "pass" : "fail",
    title: s.hasReadme ? "README present" : "No README found",
    detail: s.hasReadme
      ? undefined
      : "The README is the first thing both a visitor and an answer engine read. Without one the project is undiscoverable on its own merits.",
    evidence: { has_readme: s.hasReadme },
    priority: s.hasReadme === false ? 2 : 5,
  });

  findings.push({
    section: "Maintenance",
    check_key: "repo.description",
    status: s.description ? "pass" : "warn",
    title: s.description ? "Repository description set" : "No repository description",
    detail: s.description
      ? s.description
      : "The description is what GitHub search, and every aggregator reading its API, uses as your one-line pitch.",
    evidence: { description: s.description, topics: s.topics },
    priority: s.description ? 5 : 3,
  });

  findings.push({
    section: "Maintenance",
    check_key: "repo.homepage",
    status: s.homepage ? "pass" : "warn",
    title: s.homepage ? `Homepage set to ${s.homepage}` : "No homepage set on the repository",
    detail: s.homepage
      ? undefined
      : "Setting the repo's homepage field links the code back to the product, and adds to the undervalued score.",
    evidence: { homepage: s.homepage },
    priority: s.homepage ? 5 : 4,
  });

  // ---- Reach --------------------------------------------------------------
  findings.push({
    section: "Reach",
    check_key: "repo.reach",
    status: "pass",
    title: `${s.stars} stars · ${s.watchers} watchers · ${s.forks} forks`,
    detail: [
      `Reach factor ${score.reach.toFixed(3)} = log₁₀(${s.stars} + ${s.watchers} + 10).`,
      "Reach is the divisor, not the score: it is what the undervalued score is measured against, so a low star count raises the score rather than lowering it.",
      s.contributors === null
        ? "Contributor count unavailable."
        : `${s.contributors} contributor(s) all-time.`,
    ].join("\n"),
    evidence: {
      stars: s.stars,
      watchers: s.watchers,
      forks: s.forks,
      contributors: s.contributors,
      reach: score.reach,
    },
    priority: 5,
  });

  // ---- Tags ---------------------------------------------------------------
  for (const tag of score.tags) {
    findings.push({
      section: "Signals",
      check_key: `repo.tag.${tag}`,
      status: tag === "under_pressure" || tag === "needs_contributors" ? "warn" : "pass",
      title: TAG_LABELS[tag],
      detail: TAG_MEANINGS[tag],
      evidence: { tag },
      priority: tag === "under_pressure" ? 3 : 5,
    });
  }
  if (score.tags.length === 0) {
    findings.push({
      section: "Signals",
      check_key: "repo.tag.none",
      status: "warn",
      title: "No behavioral signals matched",
      detail:
        "None of the ten signals (solo builder, hidden gem, fork magnet, release machine, and the rest) applied. That usually means low activity rather than a mixed picture.",
      evidence: { tags: [] },
      priority: 4,
    });
  }

  // ---- What to do about it ------------------------------------------------
  const recs: Array<{ title: string; how: string; priority: Finding["priority"] }> = [];
  if (!s.description) {
    recs.push({
      title: "Write a one-line repository description",
      how: "Settings → Description. One sentence naming what it does and who it is for.",
      priority: 3,
    });
  }
  if (!s.homepage) {
    recs.push({
      title: "Set the repository homepage",
      how: "Settings → Website. Point it at the product site; it links the code back to the thing it builds.",
      priority: 4,
    });
  }
  if (s.hasReadme === false) {
    recs.push({
      title: "Add a README",
      how: "What it does, how to install it, and one working example — in that order.",
      priority: 2,
    });
  }
  if (!s.license) {
    recs.push({
      title: "Add a LICENSE file",
      how: "Pick one at choosealicense.com; without it the code is all-rights-reserved by default.",
      priority: 3,
    });
  }
  if (s.topics.length === 0) {
    recs.push({
      title: "Add repository topics",
      how: "Topics are how GitHub search and every downstream aggregator categorise the project.",
      priority: 4,
    });
  }
  if ((s.releases90 ?? 0) === 0) {
    recs.push({
      title: "Cut a tagged release",
      how: "Even one tagged release gives users something to pin and reads as active maintenance.",
      priority: 4,
    });
  }
  if (score.daysSinceCommit !== null && score.daysSinceCommit > 90) {
    recs.push({
      title: "Land a commit — the repo reads as dormant",
      how: `The last commit was ${ago(s.lastCommitAt, now)}. Recency is 35% of the health score.`,
      priority: 1,
    });
  }
  if (score.tags.includes("solo_builder") && (s.helpWantedOpen ?? 0) === 0) {
    recs.push({
      title: 'Label a few issues "good first issue"',
      how: "One person holds most of the commits. Labelled entry points are the cheapest way to widen that.",
      priority: 4,
    });
  }
  for (const r of recs) {
    findings.push({
      section: "Recommended Fixes",
      check_key: `repo.rec.${r.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40)}`,
      status: "warn",
      title: r.title,
      detail: r.how,
      evidence: {},
      priority: r.priority,
    });
  }

  // Collection problems are reported, not hidden — a score computed from
  // partial signals should say which parts were missing.
  if (s.notes.length > 0) {
    findings.push({
      section: "Repository",
      check_key: "repo.collection_notes",
      status: "unknown",
      title: `${s.notes.length} signal(s) could not be read`,
      detail: `${s.notes.map((n) => `· ${n}`).join("\n")}\n\nWeights for missing components were redistributed across the ones that were read.`,
      evidence: { notes: s.notes },
      priority: 4,
    });
  }

  return findings;
}

function buildMarkdown(s: RepoSignals, score: RepoScore, findings: Finding[], now: number): string {
  const glyph = (st: Finding["status"]) =>
    st === "pass" ? "✅" : st === "warn" ? "⚠️" : st === "fail" ? "❌" : "❓";
  const slug = s.fullName;

  const lines: string[] = [
    `# Repo Health — ${slug}`,
    "",
    `**Health ${score.health}/100 · ${score.band}** — ${BAND_MEANINGS[score.band]}`,
    "",
    `**Undervalued ${score.undervalued}/100** — ${
      score.undervalued >= 50
        ? "the work is outrunning the audience."
        : "attention is currently ahead of output."
    }`,
    "",
    score.tags.length > 0
      ? score.tags.map((t) => `\`${TAG_LABELS[t]}\``).join(" · ")
      : "_No behavioral signals matched._",
    "",
    "## Stats",
    "",
    "| | |",
    "| --- | --- |",
    `| Last commit | ${ago(s.lastCommitAt, now)} |`,
    `| Commits (90d) | ${s.commits90} |`,
    `| Latest release | ${s.latestReleaseAt ? ago(s.latestReleaseAt, now) : "none"} |`,
    `| Releases (90d) | ${s.releases90 ?? "unknown"} |`,
    `| Open / closed issues | ${s.openIssues ?? "?"} / ${s.closedIssues ?? "?"} |`,
    `| Merged / total PRs | ${s.mergedPrs ?? "?"} / ${s.totalPrs ?? "?"} |`,
    `| Stars / watchers / forks | ${s.stars} / ${s.watchers} / ${s.forks} |`,
    `| Contributors | ${s.contributors ?? "unknown"} |`,
    `| Created | ${fmtDate(s.createdAt)} |`,
    `| License | ${s.license ?? "none"} |`,
    "",
    "## How the scores are built",
    "",
    "```",
    "health = 0.35·recency       // days since last commit (90d decay)",
    "       + 0.25·cadence       // commit rhythm consistency",
    "       + 0.20·issue_health  // closed ÷ total issues",
    "       + 0.20·pr_health     // merged ÷ total PRs",
    "",
    "signal = 0.25·commit_velocity   // commits in last 90 days (cap 30)",
    "       + 0.20·contributor_work  // unique authors × velocity (cap 100)",
    "       + 0.20·issue_resolution  // closed ÷ total issues",
    "       + 0.20·fork_ratio        // forks ÷ stars (proxy for real usage)",
    "       + 0.10·release_cadence   // releases in 90 days (cap 3)",
    "       + age_bonus              // +0 to +0.30 after 6 months",
    "       + homepage_bonus         // +0.05 if homepage is set",
    "reach  = log₁₀(stars + watchers + 10)",
    "score  = signal ÷ reach",
    "```",
    "",
    `This repo: signal ${score.signal.toFixed(3)} ÷ reach ${score.reach.toFixed(3)} = **${score.undervalued}**.`,
    "",
    "Stars are an outcome, not effort. Measuring the building and dividing by the",
    "attention already received is what lets a genuinely undervalued project rise.",
    "",
    "## Findings",
    "",
  ];

  const sections = [...new Set(findings.map((f) => f.section))];
  for (const section of sections) {
    lines.push(`### ${section}`, "");
    for (const f of findings.filter((x) => x.section === section)) {
      lines.push(`- ${glyph(f.status)} **${f.title}**`);
      if (f.detail) lines.push(`  ${f.detail.replace(/\n/g, "\n  ")}`);
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    `Scored from the public GitHub API for [${slug}](https://github.com/${slug}), found via ${SOURCE_LABEL[s.source]}.`,
  );

  return lines.join("\n");
}

/** Findings shown when the site has no GitHub repository we can score. */
function notFoundResult(target: string, started: number): RepoAuditResult {
  const findings: Finding[] = [
    {
      section: "Repository",
      check_key: "repo.identified",
      status: "unknown",
      title: "No GitHub repository found for this site",
      detail:
        "We looked at the scan target, the repositories connected to this project, and every GitHub link on the homepage. Connect a repository to the project, or scan the github.com/owner/repo URL directly, to get a repo health score.",
      evidence: { target },
      priority: 3,
    },
  ];
  return {
    score: 0,
    findings,
    summary: {
      pagesCrawled: 0,
      pass: 0,
      warn: 0,
      fail: 0,
      unknown: 1,
      dataFound: [],
      durationMs: Date.now() - started,
    },
    markdown: [
      "# Repo Health",
      "",
      `No GitHub repository could be found for ${target}.`,
      "",
      "We checked the scan target, the repositories connected to this project, and the GitHub links on the homepage.",
      "Connect a repository to this project, or scan the `github.com/owner/repo` URL directly.",
    ].join("\n"),
  };
}

export async function repoAudit(
  target: string,
  options: RepoAuditOptions = {},
): Promise<RepoAuditResult> {
  const started = Date.now();
  const now = options.now ?? started;
  const token =
    options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;

  const resolved = await resolveRepo(target, options);
  if (!resolved) return notFoundResult(target, started);

  const signals = await collectRepoSignals(resolved.ref, resolved.source, {
    token,
    fetchImpl: options.fetchImpl,
    now,
  });
  const score = scoreRepo(signals, now);
  const findings = buildFindings(signals, score, now);

  return {
    score: score.health,
    findings,
    summary: {
      pagesCrawled: 0,
      pass: findings.filter((f) => f.status === "pass").length,
      warn: findings.filter((f) => f.status === "warn").length,
      fail: findings.filter((f) => f.status === "fail").length,
      unknown: findings.filter((f) => f.status === "unknown").length,
      dataFound: [
        {
          dataPoint: "Repository",
          found: true,
          source: `https://github.com/${signals.fullName}`,
          notes: `Health ${score.health} (${score.band}), undervalued ${score.undervalued}`,
        },
      ],
      durationMs: Date.now() - started,
    },
    markdown: buildMarkdown(signals, score, findings, now),
  };
}
