import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProjectShell } from "@/components/project-shell";
import { env } from "@/lib/env";
import { DEFAULT_PROJECT_ENGINES, type Engine } from "@/lib/credits";
import type { ProjectStatus } from "@/app/actions/projects";
import {
  TrackerAnalytics,
  type TrackerPanels,
} from "@/components/charts/tracker-analytics";
import { fetchPanels, PANEL_KEYS } from "@/lib/tracker/panels";
import {
  AI_REFERRALS_DEFINITION,
  BOTS_DEFINITION,
  BOTS_LABEL,
  HUMANS_DEFINITION,
  HUMANS_LABEL,
} from "@/lib/tracker/humans";
import { DEFAULT_TRACKER_RANGE, trackerRange } from "@/lib/tracker/ranges";
import { InstallSnippet } from "./install-snippet";
import { TrackerToggle } from "./tracker-toggle";
import { CareersToggle } from "./careers-toggle";
import { AutoInstall } from "./auto-install";
import { LiveVisitors } from "./live-visitors";
import { StatsSubnav } from "./stats-subnav";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import { listInstallationRepos } from "@/lib/github/app";

type BoundRepo = {
  id: string;
  full_name: string;
  installation_id: number;
  default_branch: string | null;
  added_at: string;
};

export default async function ProjectStatsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  // All stats are aggregated server-side (see the tracker_* RPCs). The page
  // used to fetch raw rollup rows and bucket them in JS, but PostgREST caps a
  // response at 1000 rows — busy projects blew past that and the newest-first
  // ordering silently dropped older history, so charts looked like tracking
  // "just started". Aggregating in Postgres returns at most (days) or (lim)
  // rows per call, so history is always complete.
  //
  // This renders every panel at the default range. Each card then owns its own
  // timeframe tabs and re-fetches just itself from
  // /api/projects/:id/tracker-stats, so narrowing one chart to the last hour
  // does not re-run the other eleven.
  const range = trackerRange(DEFAULT_TRACKER_RANGE);
  const panels = (await fetchPanels(
    supabase,
    id,
    PANEL_KEYS,
    range,
  )) as unknown as TrackerPanels;

  // Headline metrics come straight from the series so they stay exact even
  // though Top sources below is truncated to the top 10 buckets. The page
  // leads with humans (every bucket that is not `bot:`, AI referrals
  // included) and shows bot crawls apart — see lib/tracker/humans.ts for why
  // the old bot-inclusive total is no longer a headline.
  const points = panels.series.points;
  const totalAi = points.reduce((s, p) => s + p.ai, 0);
  const totalBot = points.reduce((s, p) => s + p.bots, 0);
  const totalHuman = points.reduce((s, p) => s + p.humans, 0);
  const grandTotal = points.reduce((s, p) => s + p.events, 0);
  const eventTotal = points.reduce((s, p) => s + p.pageviews + p.interactions, 0);

  // Older projects have rollup rows in tracker_daily_stats but nothing in
  // tracker_event_daily_stats, which would leave Event mix empty on a page
  // that is plainly showing traffic. Fall back to a single Pageview row.
  if (!panels.events.length && grandTotal) {
    panels.events = [{ label: "Pageview", value: grandTotal }];
  }

  const trackerEnabled = !!(project as { tracker_enabled?: boolean })
    .tracker_enabled;
  const careersEnabled = !!(project as { careers_enabled?: boolean })
    .careers_enabled;

  // GitHub auto-install: best-effort. If env is missing or the user has
  // no connected installations, we just hide the button.
  const ghConfigured = !!(env.githubAppId && env.githubAppPrivateKey);
  const { data: { user } } = await supabase.auth.getUser();
  const installations: Array<{ installation_id: number; account_login: string }> = [];
  const ghRepos: Array<{
    full_name: string;
    installation_id: number;
    default_branch?: string | null;
  }> = [];
  let boundRepos: BoundRepo[] = [];
  if (ghConfigured && user) {
    const { data: rows } = await supabase
      .from("github_installations")
      .select("installation_id, account_login")
      .is("removed_at", null);
    for (const r of (rows ?? []) as Array<{ installation_id: number; account_login: string }>) {
      installations.push(r);
      try {
        const token = await getOrMintInstallationToken(r.installation_id);
        const repos = await listInstallationRepos(token);
        for (const repo of repos) {
          ghRepos.push({
            full_name: repo.full_name,
            installation_id: r.installation_id,
            default_branch: repo.default_branch,
          });
        }
      } catch {
        // Skip this installation if listing fails; the settings page will
        // show the error.
      }
    }
    const { data: boundData } = await supabase
      .from("project_repos")
      .select("id, installation_id, repo_owner, repo_name, default_branch, added_at")
      .eq("project_id", id);
    boundRepos = ((boundData ?? []) as Array<{
      id: string;
      installation_id: number;
      repo_owner: string;
      repo_name: string;
      default_branch: string | null;
      added_at: string;
    }>).map((b) => ({
      id: b.id,
      full_name: `${b.repo_owner}/${b.repo_name}`,
      installation_id: b.installation_id,
      default_branch: b.default_branch,
      added_at: b.added_at,
    }));
  }

  return (
    <ProjectShell
      project={{
        id: project.id,
        name: project.name,
        url: project.url,
        schedule: project.schedule,
        status: (project.status ?? "active") as ProjectStatus,
        engines: (project.engines ?? DEFAULT_PROJECT_ENGINES) as Engine[],
        logo_url: (project as { logo_url?: string | null }).logo_url ?? null,
      }}
      currentTab="stats"
    >
      <div className="space-y-6">
        <StatsSubnav projectId={id} />

        <LiveVisitors projectId={id} />

        <section className="card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
            <div>
              <h2 className="text-lg font-semibold">Drop-in stats tracker</h2>
              <p className="text-sm text-[var(--color-muted)]">
                {trackerEnabled
                  ? "Live and accepting pageviews."
                  : "Disabled. Enable to start receiving events."}
              </p>
            </div>
            <TrackerToggle projectId={id} initialEnabled={trackerEnabled} />
          </div>
          {trackerEnabled && (
            <>
              <InstallSnippet
                projectId={id}
                projectName={project.name}
                projectUrl={project.url}
                siteUrl={env.siteUrl}
              />
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Tracking from a server, cron, mobile app, or CLI?{" "}
                <a
                  href="/docs/statistics#server-side"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-[var(--color-foreground)]"
                >
                  See the programmatic / CLI docs →
                </a>
              </p>
              <div className="mt-3">
                <AutoInstall
                  projectId={id}
                  projectName={project.name}
                  projectUrl={project.url}
                  installations={installations}
                  repos={ghRepos}
                  boundRepos={boundRepos}
                  notConfigured={!ghConfigured}
                />
              </div>
            </>
          )}
          {ghConfigured && (
            <ConnectedRepos projectId={id} repos={boundRepos} />
          )}
        </section>

        {trackerEnabled && (
          <section className="card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">Careers widget</h2>
                <p className="text-sm text-[var(--color-muted)]">
                  {careersEnabled ? (
                    <>
                      Loaded — your snippet paints a job board on /careers.{" "}
                      <a
                        href={`/dashboard/projects/${id}/stats/careers`}
                        className="underline hover:text-[var(--color-foreground)]"
                      >
                        Manage roles and applicants →
                      </a>
                    </>
                  ) : (
                    "Optional module. Publish job openings through the snippet you already installed — no second script tag."
                  )}
                </p>
              </div>
              <CareersToggle projectId={id} initialEnabled={careersEnabled} />
            </div>
          </section>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <Metric
            label={HUMANS_LABEL}
            value={totalHuman}
            tone="accent"
            hint={HUMANS_DEFINITION}
          />
          <Metric
            label="AI referrals"
            value={totalAi}
            tone="pass"
            hint={AI_REFERRALS_DEFINITION}
          />
          <Metric
            label={BOTS_LABEL}
            value={totalBot}
            tone="warn"
            hint={BOTS_DEFINITION}
          />
        </div>

        {grandTotal === 0 && eventTotal === 0 ? (
          <section className="card p-4">
            <p className="text-sm text-[var(--color-muted)]">
              {trackerEnabled
                ? "No events yet. Once the snippet is installed and your site gets traffic, sources will appear here."
                : "Enable the tracker to start collecting events."}
            </p>
          </section>
        ) : (
          <TrackerAnalytics
            projectId={id}
            initial={panels}
            initialRange={range.key}
          />
        )}
      </div>
    </ProjectShell>
  );
}

function ConnectedRepos({
  projectId,
  repos,
}: {
  projectId: string;
  repos: BoundRepo[];
}) {
  return (
    <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Connected repos</h3>
          <p className="text-xs text-[var(--color-muted)]">
            These repos stay attached to this project and appear first in GitHub actions.
          </p>
        </div>
        <a
          href={`/dashboard/projects/${projectId}/repos`}
          className="text-xs text-[var(--color-muted)] underline hover:text-[var(--color-fg)]"
        >
          Manage repos
        </a>
      </div>

      {repos.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          No repo connected yet. Install via GitHub or add one on the Repos tab.
        </p>
      ) : (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {repos.map((repo) => (
            <li
              key={repo.id}
              className="rounded border border-[var(--color-border)] px-3 py-2"
            >
              <p className="truncate text-sm font-medium">{repo.full_name}</p>
              <p className="text-xs text-[var(--color-muted)]">
                {repo.default_branch ?? "default branch"} · connected{" "}
                {new Date(repo.added_at).toLocaleDateString()}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: "accent" | "pass" | "warn" | "muted";
  /** What this number counts; shown on hover and under the figure. */
  hint?: string;
}) {
  const color =
    tone === "pass"
      ? "text-green-600"
      : tone === "warn"
        ? "text-yellow-600"
        : "text-[var(--color-foreground)]";
  return (
    <div className="card p-4" title={hint}>
      <p className="text-xs text-[var(--color-muted)]">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>
        {value.toLocaleString()}
      </p>
      {hint && (
        <p className="mt-1 text-[11px] leading-snug text-[var(--color-muted)]">
          {hint}
        </p>
      )}
    </div>
  );
}
