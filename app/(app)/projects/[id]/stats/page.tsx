import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProjectShell } from "@/components/project-shell";
import { bucketLabel } from "@/lib/tracker/categorize";
import { env } from "@/lib/env";
import type { Engine } from "@/lib/credits";
import type { ProjectStatus } from "@/app/actions/projects";
import {
  TrackerAnalytics,
  type TrackerDailyPoint,
  type TrackerListItem,
} from "@/components/charts/tracker-analytics";
import { InstallSnippet } from "./install-snippet";
import { TrackerToggle } from "./tracker-toggle";
import { AutoInstall } from "./auto-install";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import { listInstallationRepos } from "@/lib/github/app";

type StatsRow = { bucket: string; day: string; count: number };
type EventRow = {
  day: string;
  event: string;
  page_path: string;
  referrer_host: string;
  event_target: string;
  count: number;
};
type BoundRepo = {
  id: string;
  full_name: string;
  installation_id: number;
  default_branch: string | null;
  added_at: string;
};
type GeoRow = {
  country_code: string;
  country_name: string;
  region_code: string;
  region_name: string;
  city: string;
  timezone: string;
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

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: stats } = await supabase
    .from("tracker_daily_stats")
    .select("bucket, day, count")
    .eq("project_id", id)
    .gte("day", since)
    .order("day", { ascending: false });

  const rows = (stats ?? []) as StatsRow[];

  const { data: eventStats } = await supabase
    .from("tracker_event_daily_stats")
    .select("day, event, page_path, referrer_host, event_target, count")
    .eq("project_id", id)
    .gte("day", since)
    .order("day", { ascending: false });

  const eventRows = (eventStats ?? []) as EventRow[];

  const { data: geoStats } = await supabase
    .from("tracker_geo_daily_stats")
    .select("country_code, country_name, region_code, region_name, city, timezone, count")
    .eq("project_id", id)
    .gte("day", since);

  const geoRows = (geoStats ?? []) as GeoRow[];

  // Roll up by bucket for the table view; sort by total desc.
  const byBucket = new Map<string, number>();
  let totalAi = 0;
  let totalBot = 0;
  let totalHuman = 0;
  for (const r of rows) {
    byBucket.set(r.bucket, (byBucket.get(r.bucket) ?? 0) + r.count);
    if (r.bucket.startsWith("ai_referral:")) totalAi += r.count;
    else if (r.bucket.startsWith("bot:")) totalBot += r.count;
    else if (r.bucket.startsWith("human:") || r.bucket.startsWith("search:") || r.bucket.startsWith("social:") || r.bucket.startsWith("referral:"))
      totalHuman += r.count;
  }
  const buckets = Array.from(byBucket.entries()).sort((a, b) => b[1] - a[1]);
  const grandTotal = buckets.reduce((s, [, n]) => s + n, 0);
  const daily = buildDaily(rows, eventRows);
  const eventMix = topItems(eventRows, (row) => eventLabel(row.event), {
    fallback: grandTotal ? [{ label: "Pageview", value: grandTotal }] : [],
  });
  const topSources = buckets.slice(0, 10).map(([bucket, count]) => ({
    label: bucketLabel(bucket),
    value: count,
  }));
  const topPages = topItems(
    eventRows.filter((row) => row.event === "pageview"),
    (row) => row.page_path || "/",
  );
  const topReferrers = topItems(
    eventRows.filter((row) => row.referrer_host),
    (row) => row.referrer_host,
  );
  const topActions = topItems(
    eventRows.filter((row) => row.event !== "pageview" && row.event_target),
    (row) => `${eventLabel(row.event)} · ${row.event_target}`,
  );
  const topCountries = topGeoItems(geoRows, (row) =>
    row.countryName || row.countryCode
      ? `${row.countryName || row.countryCode}${row.countryCode ? ` (${row.countryCode})` : ""}`
      : "",
  );
  const topCities = topGeoItems(geoRows, (row) => {
    if (!row.city) return "";
    const region = row.regionCode || row.regionName;
    const country = row.countryCode || row.countryName;
    return [row.city, region, country].filter(Boolean).join(", ");
  });

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
        engines: (project.engines ?? ["rule"]) as Engine[],
        logo_url: (project as { logo_url?: string | null }).logo_url ?? null,
      }}
      currentTab="stats"
    >
      <div className="space-y-6">
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
              <InstallSnippet projectId={id} siteUrl={env.siteUrl} />
              <div className="mt-3">
                <AutoInstall
                  projectId={id}
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

        {grandTotal === 0 && eventRows.length === 0 ? (
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
            referrers={topReferrers}
            actions={topActions}
            countries={topCountries}
            cities={topCities}
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

function buildDaily(rows: StatsRow[], eventRows: EventRow[]): TrackerDailyPoint[] {
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

  for (const row of rows) {
    const point = byDay.get(row.day);
    if (!point) continue;
    point.events += row.count;
    if (row.bucket.startsWith("ai_referral:")) point.ai += row.count;
    if (row.bucket.startsWith("bot:")) point.bots += row.count;
  }

  for (const row of eventRows) {
    const point = byDay.get(row.day);
    if (!point) continue;
    if (row.event === "pageview") point.pageviews += row.count;
    else point.interactions += row.count;
  }

  for (const point of byDay.values()) {
    if (point.events === 0) point.events = point.pageviews + point.interactions;
  }

  return Array.from(byDay.values());
}

function topItems(
  rows: EventRow[],
  labelFor: (row: EventRow) => string,
  options: { fallback?: TrackerListItem[] } = {},
): TrackerListItem[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    const label = labelFor(row);
    if (!label) continue;
    map.set(label, (map.get(label) ?? 0) + row.count);
  }
  const items = Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  return items.length ? items : options.fallback ?? [];
}

function topGeoItems(
  rows: GeoRow[],
  labelFor: (row: {
    countryCode: string;
    countryName: string;
    regionCode: string;
    regionName: string;
    city: string;
    timezone: string;
    count: number;
  }) => string,
): TrackerListItem[] {
  const map = new Map<string, number>();
  for (const row of rows) {
    const normalized = {
      countryCode: row.country_code,
      countryName: row.country_name,
      regionCode: row.region_code,
      regionName: row.region_name,
      city: row.city,
      timezone: row.timezone,
      count: row.count,
    };
    const label = labelFor(normalized);
    if (!label) continue;
    map.set(label, (map.get(label) ?? 0) + row.count);
  }
  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
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
