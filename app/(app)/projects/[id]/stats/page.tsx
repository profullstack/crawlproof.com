import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProjectShell } from "@/components/project-shell";
import { bucketLabel } from "@/lib/tracker/categorize";
import { countryNameFromCode } from "@/lib/tracker/country";
import { env } from "@/lib/env";
import { DEFAULT_PROJECT_ENGINES, type Engine } from "@/lib/credits";
import type { ProjectStatus } from "@/app/actions/projects";
import {
  TrackerAnalytics,
  type TrackerDailyPoint,
  type TrackerListItem,
} from "@/components/charts/tracker-analytics";
import { InstallSnippet } from "./install-snippet";
import { TrackerToggle } from "./tracker-toggle";
import { AutoInstall } from "./auto-install";
import { LiveVisitors } from "./live-visitors";
import { StatsSubnav } from "./stats-subnav";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import { listInstallationRepos } from "@/lib/github/app";

// Shape returned by the tracker_daily_series RPC. bigint columns arrive as
// strings over PostgREST, so we coerce with Number() at the call site.
type SeriesRow = {
  day: string;
  pageviews: number | string;
  interactions: number | string;
  ai: number | string;
  bots: number | string;
  events: number | string;
};
type BoundRepo = {
  id: string;
  full_name: string;
  installation_id: number;
  default_branch: string | null;
  added_at: string;
};
type DeviceRow = {
  device_type: string;
  browser: string;
  os: string;
  count: number;
};

const WINDOW_DAYS = 30;

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
  const days = WINDOW_DAYS;
  const [
    seriesRes,
    bucketsRes,
    mixRes,
    pagesRes,
    referrersRes,
    actionsRes,
    exitRes,
    countriesRes,
    citiesRes,
    devicesRes,
  ] = await Promise.all([
    supabase.rpc("tracker_daily_series", { p_project: id, days }),
    supabase.rpc("tracker_bucket_totals", { p_project: id, days, lim: 10 }),
    supabase.rpc("tracker_event_mix", { p_project: id, days }),
    supabase.rpc("tracker_top_pages", { p_project: id, days, lim: 10 }),
    supabase.rpc("tracker_top_referrers", { p_project: id, days, lim: 10 }),
    supabase.rpc("tracker_top_actions", { p_project: id, days, lim: 10 }),
    supabase.rpc("tracker_top_exit_pages", { p_project: id, days, lim: 10 }),
    supabase.rpc("tracker_top_countries", { p_project: id, days, lim: 10 }),
    supabase.rpc("tracker_top_cities", { p_project: id, days, lim: 10 }),
    supabase.rpc("tracker_device_totals", { p_project: id, days }),
  ]);

  const series = ((seriesRes.data ?? []) as SeriesRow[]).map((r) => ({
    day: r.day,
    pageviews: Number(r.pageviews),
    interactions: Number(r.interactions),
    ai: Number(r.ai),
    bots: Number(r.bots),
    events: Number(r.events),
  }));
  const daily = buildDaily(series);

  // Headline metrics come straight from the series so they stay exact even
  // though Top sources below is truncated to the top 10 buckets. "Other visits"
  // is everything that isn't an AI referral or a bot (human/search/social/
  // referral), matching the original bucket-prefix split.
  const totalAi = series.reduce((s, p) => s + p.ai, 0);
  const totalBot = series.reduce((s, p) => s + p.bots, 0);
  const grandTotal = series.reduce((s, p) => s + p.events, 0);
  const eventTotal = series.reduce((s, p) => s + p.pageviews + p.interactions, 0);
  const totalHuman = Math.max(0, grandTotal - totalAi - totalBot);

  const topSources = (
    (bucketsRes.data ?? []) as Array<{ bucket: string; total: number | string }>
  ).map((r) => ({ label: bucketLabel(r.bucket), value: Number(r.total) }));

  const mixItems = (
    (mixRes.data ?? []) as Array<{ event: string; total: number | string }>
  )
    .map((r) => ({ label: eventLabel(r.event), value: Number(r.total) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  const eventMix: TrackerListItem[] = mixItems.length
    ? mixItems
    : grandTotal
      ? [{ label: "Pageview", value: grandTotal }]
      : [];

  const topPages = (
    (pagesRes.data ?? []) as Array<{ page_path: string; total: number | string }>
  ).map((r) => ({ label: r.page_path || "/", value: Number(r.total) }));

  const topReferrers = (
    (referrersRes.data ?? []) as Array<{
      referrer_host: string;
      total: number | string;
    }>
  ).map((r) => ({ label: r.referrer_host, value: Number(r.total) }));

  const topActions = (
    (actionsRes.data ?? []) as Array<{
      event: string;
      event_target: string;
      total: number | string;
    }>
  ).map((r) => ({
    label: `${eventLabel(r.event)} · ${r.event_target}`,
    value: Number(r.total),
  }));

  const exitPages = (
    (exitRes.data ?? []) as Array<{ page_path: string; total: number | string }>
  ).map((r) => ({ label: r.page_path || "/", value: Number(r.total) }));

  const topCountries = (
    (countriesRes.data ?? []) as Array<{
      country_code: string;
      country_name: string;
      total: number | string;
    }>
  )
    .map((r) => ({
      label:
        r.country_name || r.country_code
          ? `${r.country_name || countryNameFromCode(r.country_code) || r.country_code}${r.country_code ? ` (${r.country_code})` : ""}`
          : "",
      value: Number(r.total),
    }))
    .filter((it) => it.label);

  const topCities = (
    (citiesRes.data ?? []) as Array<{
      city: string;
      region_code: string;
      region_name: string;
      country_code: string;
      country_name: string;
      total: number | string;
    }>
  )
    .map((r) => {
      const region = r.region_code || r.region_name;
      const country = r.country_code || r.country_name;
      return {
        label: [r.city, region, country].filter(Boolean).join(", "),
        value: Number(r.total),
      };
    })
    .filter((it) => it.label);

  const deviceRows = (
    (devicesRes.data ?? []) as Array<{
      device_type: string;
      browser: string;
      os: string;
      total: number | string;
    }>
  ).map((r) => ({
    device_type: r.device_type,
    browser: r.browser,
    os: r.os,
    count: Number(r.total),
  }));

  const topDevices = topDeviceItems(deviceRows, (row) =>
    deviceTypeLabel(row.device_type),
  );
  const topBrowsers = topDeviceItems(deviceRows, (row) => row.browser);
  const topOperatingSystems = topDeviceItems(deviceRows, (row) => row.os);

  const trackerEnabled = !!(project as { tracker_enabled?: boolean })
    .tracker_enabled;

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

        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="AI referrals" value={totalAi} tone="pass" />
          <Metric label="AI / bot crawls" value={totalBot} tone="warn" />
          <Metric label="Other visits" value={totalHuman} tone="muted" />
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
            daily={daily}
            events={eventMix}
            sources={topSources}
            pages={topPages}
            exitPages={exitPages}
            referrers={topReferrers}
            actions={topActions}
            countries={topCountries}
            cities={topCities}
            devices={topDevices}
            browsers={topBrowsers}
            operatingSystems={topOperatingSystems}
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
          href={`/projects/${projectId}/repos`}
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

// Map the per-day series onto a zero-filled WINDOW_DAYS axis (UTC) so gaps
// render as flat spans rather than being skipped. Days beyond the RPC's own
// window (should be none) are ignored.
function buildDaily(
  series: Array<{
    day: string;
    pageviews: number;
    interactions: number;
    ai: number;
    bots: number;
    events: number;
  }>,
): TrackerDailyPoint[] {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - WINDOW_DAYS + 1);

  const byDay = new Map<string, TrackerDailyPoint>();
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    byDay.set(date, {
      date,
      events: 0,
      pageviews: 0,
      interactions: 0,
      ai: 0,
      bots: 0,
    });
  }

  for (const row of series) {
    const point = byDay.get(row.day);
    if (!point) continue;
    point.pageviews += row.pageviews;
    point.interactions += row.interactions;
    point.ai += row.ai;
    point.bots += row.bots;
    point.events += row.events;
  }

  for (const point of byDay.values()) {
    if (point.events === 0) point.events = point.pageviews + point.interactions;
  }

  return Array.from(byDay.values());
}

function topDeviceItems(
  rows: DeviceRow[],
  labelFor: (row: DeviceRow) => string,
): TrackerListItem[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    const label = labelFor(row);
    if (!label) continue;
    map.set(label, (map.get(label) ?? 0) + row.count);
  }
  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
}

function deviceTypeLabel(deviceType: string) {
  switch (deviceType) {
    case "mobile":
      return "Mobile";
    case "tablet":
      return "Tablet";
    case "desktop":
      return "Desktop";
    case "bot":
      return "Bot";
    default:
      return "";
  }
}

function eventLabel(event: string) {
  return event
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "pass" | "warn" | "muted";
}) {
  const color =
    tone === "pass"
      ? "text-green-600"
      : tone === "warn"
        ? "text-yellow-600"
        : "text-[var(--color-foreground)]";
  return (
    <div className="card p-4">
      <p className="text-xs text-[var(--color-muted)]">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}
