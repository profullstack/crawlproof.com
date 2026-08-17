import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ProjectLogo } from "@/components/project-logo";
import { FontSparkline } from "@/components/font-sparkline";
import { bucketLabel } from "@/lib/tracker/categorize";
import { countryNameFromCode } from "@/lib/tracker/country";
import { getOrCreateDefaultOrg, isOrgWideRole, listUserOrgs } from "@/lib/orgs";
import { buildDailyAxis, toSeriesRow, utcDayAxis } from "@/lib/tracker/series";
import {
  computeTrend,
  formatTrend,
  portfolioVerdict,
  type Trend,
  type TrendDirection,
} from "@/lib/tracker/trend";
import {
  TrackerAnalytics,
  type TrackerListItem,
} from "@/components/charts/tracker-analytics";
import {
  OTHER_KEY,
  PortfolioTrend,
  type PortfolioPoint,
  type PortfolioSeries,
} from "@/components/charts/portfolio-trend";

export const metadata = { title: "Analytics" };

// The per-project stats page is fixed at 30 days; the portfolio view is the
// place you go to ask "over what horizon?", so the window is selectable.
const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];
const DEFAULT_RANGE: Range = 30;

// How many properties get their own band in the stacked chart. Everything else
// collapses into "Other", derived by subtraction so the total stays exact.
const CHART_BANDS = 6;

// tracker_project_daily_series returns projects x days rows and PostgREST caps
// a response at 1000, so only fetch daily detail for as many properties as fit
// under a conservative budget. The rest still get totals and a trend — they
// just can't show a sparkline.
const DAILY_ROW_BUDGET = 900;

type PortfolioProject = {
  id: string;
  name: string;
  url: string;
  status: string;
  logo_url: string | null;
  organization_id?: string | null;
};

type TotalsRow = {
  project_id: string;
  events: number | string;
  ai: number | string;
  bots: number | string;
  prev_events: number | string;
  prev_ai: number | string;
  prev_bots: number | string;
};

type ProjectTotals = {
  events: number;
  ai: number;
  bots: number;
  prevEvents: number;
  prevAi: number;
  prevBots: number;
};

type ProjectRow = {
  project: PortfolioProject;
  totals: ProjectTotals;
  trend: Trend;
  samples: number[] | null;
};

export default async function PortfolioAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; org?: string }>;
}) {
  const { days: daysParam, org: orgParam } = await searchParams;
  const days = parseRange(daysParam);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: memberRows } = await supabase
    .from("project_members")
    .select("project_id")
    .eq("user_id", user!.id);
  const memberIds = (memberRows ?? []).map(
    (r: { project_id: string }) => r.project_id,
  );

  let orgs = await listUserOrgs(supabase, user!.id);
  if (orgs.length === 0) {
    const org = await getOrCreateDefaultOrg({
      userId: user!.id,
      email: user!.email,
    });
    orgs = org.id ? [org] : [];
  }
  // Unlike the dashboard, this page defaults to every organization the viewer
  // belongs to — "across all properties" is the whole point. `?org=` narrows.
  const selectedOrg = orgs.find((org) => org.id === orgParam) ?? null;
  const orgWideIds = orgs
    .filter((org) => isOrgWideRole(org.role))
    .map((org) => org.id);
  const accessFilter = buildProjectAccessFilter(user!.id, memberIds, orgWideIds);

  const orgSchemaReady = orgs.length > 0;
  const projectColumns = orgSchemaReady
    ? "id,name,url,status,logo_url,organization_id"
    : "id,name,url,status,logo_url";

  // Archived projects are excluded: they are gone from the portfolio by
  // definition, and their historical traffic would drag the trend.
  let projectsQuery = supabase
    .from("projects")
    .select(projectColumns)
    .in("status", ["active", "paused"]);
  if (selectedOrg?.id) {
    projectsQuery = projectsQuery.eq("organization_id", selectedOrg.id);
  }
  const { data: projectsRaw } = await projectsQuery.or(accessFilter);
  const projects = ((projectsRaw ?? []) as unknown) as PortfolioProject[];
  const projectIds = projects.map((p) => p.id);

  if (projectIds.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader days={days} orgs={orgs} selectedOrgId={selectedOrg?.id ?? null} />
        <section className="card p-4">
          <p className="text-sm text-[var(--color-muted)]">
            No projects yet.{" "}
            <Link href="/dashboard/projects/new" className="underline hover:text-[var(--color-fg)]">
              Add your first property
            </Link>{" "}
            to start seeing portfolio-wide analytics.
          </p>
        </section>
      </div>
    );
  }

  const [
    seriesRes,
    totalsRes,
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
    supabase.rpc("tracker_daily_series_multi", { p_projects: projectIds, days }),
    supabase.rpc("tracker_project_totals", { p_projects: projectIds, days }),
    supabase.rpc("tracker_bucket_totals_multi", { p_projects: projectIds, days, lim: 10 }),
    supabase.rpc("tracker_event_mix_multi", { p_projects: projectIds, days }),
    supabase.rpc("tracker_top_pages_multi", { p_projects: projectIds, days, lim: 10 }),
    supabase.rpc("tracker_top_referrers_multi", { p_projects: projectIds, days, lim: 10 }),
    supabase.rpc("tracker_top_actions_multi", { p_projects: projectIds, days, lim: 10 }),
    supabase.rpc("tracker_top_exit_pages_multi", { p_projects: projectIds, days, lim: 10 }),
    supabase.rpc("tracker_top_countries_multi", { p_projects: projectIds, days, lim: 10 }),
    supabase.rpc("tracker_top_cities_multi", { p_projects: projectIds, days, lim: 10 }),
    supabase.rpc("tracker_device_totals_multi", { p_projects: projectIds, days }),
  ]);

  const series = ((seriesRes.data ?? []) as Parameters<typeof toSeriesRow>[0][]).map(
    toSeriesRow,
  );
  const daily = buildDailyAxis(series, days);

  const totalsByProject = new Map<string, ProjectTotals>();
  for (const row of (totalsRes.data ?? []) as TotalsRow[]) {
    totalsByProject.set(row.project_id, {
      events: Number(row.events),
      ai: Number(row.ai),
      bots: Number(row.bots),
      prevEvents: Number(row.prev_events),
      prevAi: Number(row.prev_ai),
      prevBots: Number(row.prev_bots),
    });
  }

  const portfolio = sumTotals(totalsByProject.values());
  const eventsTrend = computeTrend(portfolio.events, portfolio.prevEvents);
  const aiTrend = computeTrend(portfolio.ai, portfolio.prevAi);
  const botsTrend = computeTrend(portfolio.bots, portfolio.prevBots);
  const otherTrend = computeTrend(
    otherVisits(portfolio.events, portfolio.ai, portfolio.bots),
    otherVisits(portfolio.prevEvents, portfolio.prevAi, portfolio.prevBots),
  );

  // Ranked by current-window volume: the biggest properties get the chart
  // bands, and the daily-detail budget is spent on them first.
  const ranked = projects
    .map((project) => ({
      project,
      totals: totalsByProject.get(project.id) ?? emptyTotals(),
    }))
    .sort((a, b) => b.totals.events - a.totals.events);

  const detailCount = Math.max(
    CHART_BANDS,
    Math.min(ranked.length, Math.floor(DAILY_ROW_BUDGET / days)),
  );
  const detailIds = ranked.slice(0, detailCount).map((r) => r.project.id);
  const { data: perProjectRaw } = await supabase.rpc(
    "tracker_project_daily_series",
    { p_projects: detailIds, days },
  );

  const axis = utcDayAxis(days);
  const dailyByProject = new Map<string, Map<string, number>>();
  for (const id of detailIds) dailyByProject.set(id, new Map());
  for (const row of (perProjectRaw ?? []) as Array<{
    project_id: string;
    day: string;
    events: number | string;
  }>) {
    dailyByProject.get(row.project_id)?.set(row.day, Number(row.events));
  }

  const rows: ProjectRow[] = ranked.map(({ project, totals }) => {
    const byDay = dailyByProject.get(project.id);
    return {
      project,
      totals,
      trend: computeTrend(totals.events, totals.prevEvents),
      samples: byDay ? axis.map((day) => byDay.get(day) ?? 0) : null,
    };
  });

  const withTraffic = rows.filter(
    (r) => r.totals.events > 0 || r.totals.prevEvents > 0,
  );
  const verdict = portfolioVerdict(
    eventsTrend,
    withTraffic.map((r) => r.trend.direction),
  );

  // Stacked bands for the top properties; "Other" is the exact remainder of
  // the full-portfolio series, so the stack always sums to the real total.
  const banded = ranked.slice(0, CHART_BANDS).filter((r) => r.totals.events > 0);
  const bandIds = banded.map((r) => r.project.id);
  const chartSeries: PortfolioSeries[] = banded.map((r) => ({
    key: r.project.id,
    name: r.project.name,
  }));
  const hasOther = ranked.length > banded.length;
  if (hasOther) chartSeries.push({ key: OTHER_KEY, name: "Other properties" });

  const chartData: PortfolioPoint[] = daily.map((point) => {
    const row: PortfolioPoint = { date: point.date };
    let bandedTotal = 0;
    for (const id of bandIds) {
      const value = dailyByProject.get(id)?.get(point.date) ?? 0;
      row[id] = value;
      bandedTotal += value;
    }
    if (hasOther) row[OTHER_KEY] = Math.max(0, point.events - bandedTotal);
    return row;
  });

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
    : portfolio.events
      ? [{ label: "Pageview", value: portfolio.events }]
      : [];

  const nameById = new Map(projects.map((p) => [p.id, p.name] as const));
  const withProject = (projectId: string, label: string) =>
    `${nameById.get(projectId) ?? "Unknown"} · ${label}`;

  const topPages = (
    (pagesRes.data ?? []) as Array<{
      project_id: string;
      page_path: string;
      total: number | string;
    }>
  ).map((r) => ({
    label: withProject(r.project_id, r.page_path || "/"),
    value: Number(r.total),
  }));

  const exitPages = (
    (exitRes.data ?? []) as Array<{
      project_id: string;
      page_path: string;
      total: number | string;
    }>
  ).map((r) => ({
    label: withProject(r.project_id, r.page_path || "/"),
    value: Number(r.total),
  }));

  const topActions = (
    (actionsRes.data ?? []) as Array<{
      project_id: string;
      event: string;
      event_target: string;
      total: number | string;
    }>
  ).map((r) => ({
    label: withProject(r.project_id, `${eventLabel(r.event)} · ${r.event_target}`),
    value: Number(r.total),
  }));

  const topReferrers = (
    (referrersRes.data ?? []) as Array<{
      referrer_host: string;
      total: number | string;
    }>
  ).map((r) => ({ label: r.referrer_host, value: Number(r.total) }));

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

  const missingSparklines = rows.filter(
    (r) => r.samples === null && r.totals.events > 0,
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader days={days} orgs={orgs} selectedOrgId={selectedOrg?.id ?? null} />

      <section className="card p-4">
        <h2 className="text-lg font-semibold">{verdict}</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Comparing the last {days} days against the {days} days before them,
          across {projects.length}{" "}
          {projects.length === 1 ? "property" : "properties"}
          {selectedOrg ? ` in ${selectedOrg.name}` : ""}. Archived projects are
          excluded.
        </p>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TrendMetric label="All events" trend={eventsTrend} tone="accent" />
        <TrendMetric label="AI referrals" trend={aiTrend} tone="pass" />
        <TrendMetric label="AI / bot crawls" trend={botsTrend} tone="warn" />
        <TrendMetric label="Other visits" trend={otherTrend} tone="muted" />
      </div>

      {portfolio.events === 0 && portfolio.prevEvents === 0 ? (
        <section className="card p-4">
          <p className="text-sm text-[var(--color-muted)]">
            No tracked events in this window. Enable the stats tracker on a
            project to start collecting portfolio data.
          </p>
        </section>
      ) : (
        <>
          <section className="card p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">Portfolio trend</h2>
                <p className="text-sm text-[var(--color-muted)]">
                  Daily events, stacked by property.
                </p>
              </div>
              <span className="text-xs text-[var(--color-muted)]">
                {portfolio.events.toLocaleString()} events
              </span>
            </div>
            <PortfolioTrend data={chartData} series={chartSeries} />
          </section>

          <section className="card p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">By property</h2>
                <p className="text-sm text-[var(--color-muted)]">
                  Each site against its own previous {days} days.
                </p>
              </div>
              <Link
                href="/dashboard"
                className="text-xs text-[var(--color-muted)] underline hover:text-[var(--color-fg)]"
              >
                Manage projects
              </Link>
            </div>
            <ProjectTrendTable rows={rows} />
            {missingSparklines > 0 && (
              <p className="mt-3 text-xs text-[var(--color-muted)]">
                Sparklines are shown for the {detailCount} highest-traffic
                properties; {missingSparklines} more{" "}
                {missingSparklines === 1 ? "has" : "have"} totals only over this
                window. Pick a shorter range to see more of them.
              </p>
            )}
          </section>

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
        </>
      )}
    </div>
  );
}

function PageHeader({
  days,
  orgs,
  selectedOrgId,
}: {
  days: Range;
  orgs: Array<{ id: string; name: string }>;
  selectedOrgId: string | null;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Portfolio analytics</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Every property you can see, rolled into one view.
          </p>
        </div>
        <nav className="flex items-center gap-1 text-sm">
          {RANGES.map((range) => (
            <Link
              key={range}
              href={analyticsHref(range, selectedOrgId)}
              className={
                range === days
                  ? "rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1 font-medium"
                  : "rounded-md px-2 py-1 text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              }
            >
              {range}d
            </Link>
          ))}
        </nav>
      </div>
      {orgs.length > 1 && (
        <nav className="flex flex-wrap items-center gap-1 text-sm">
          <Link
            href={analyticsHref(days, null)}
            className={
              selectedOrgId === null
                ? "rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1 font-medium"
                : "rounded-md px-2 py-1 text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            }
          >
            All organizations
          </Link>
          {orgs.map((org) => (
            <Link
              key={org.id}
              href={analyticsHref(days, org.id)}
              className={
                selectedOrgId === org.id
                  ? "rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1 font-medium"
                  : "rounded-md px-2 py-1 text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              }
            >
              {org.name}
            </Link>
          ))}
        </nav>
      )}
    </section>
  );
}

function ProjectTrendTable({ rows }: { rows: ProjectRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted)]">No properties to show.</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted)]">
            <th className="py-2 pr-3 font-medium">Property</th>
            <th className="py-2 pr-3 text-right font-medium">Events</th>
            <th className="py-2 pr-3 text-right font-medium">Previous</th>
            <th className="py-2 pr-3 text-right font-medium">Change</th>
            <th className="py-2 pr-3 font-medium">Trend</th>
            <th className="py-2 text-right font-medium">AI / bots</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ project, totals, trend, samples }) => (
            <tr
              key={project.id}
              className="border-b border-[var(--color-border)] last:border-0"
            >
              <td className="py-2 pr-3">
                <Link
                  href={`/dashboard/projects/${project.id}/stats`}
                  className="flex items-center gap-2 hover:underline"
                >
                  <ProjectLogo
                    url={project.logo_url}
                    name={project.name}
                    projectId={project.id}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {project.name}
                    </span>
                    <span className="block truncate text-xs text-[var(--color-muted)]">
                      {project.url}
                      {project.status === "paused" ? " · paused" : ""}
                    </span>
                  </span>
                </Link>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {totals.events.toLocaleString()}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-[var(--color-muted)]">
                {totals.prevEvents.toLocaleString()}
              </td>
              <td className="py-2 pr-3 text-right">
                <TrendChip trend={trend} />
              </td>
              <td className="py-2 pr-3">
                {samples ? (
                  <FontSparkline samples={samples} />
                ) : (
                  <span className="text-xs text-[var(--color-muted)]">—</span>
                )}
              </td>
              <td className="py-2 text-right tabular-nums text-[var(--color-muted)]">
                {totals.ai.toLocaleString()} / {totals.bots.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrendChip({ trend }: { trend: Trend }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs tabular-nums ${directionClass(
        trend.direction,
      )} ${trend.lowVolume ? "opacity-60" : ""}`}
      title={
        trend.lowVolume
          ? "Low traffic in both windows — the percentage swings easily."
          : undefined
      }
    >
      {formatTrend(trend)}
    </span>
  );
}

function TrendMetric({
  label,
  trend,
  tone,
}: {
  label: string;
  trend: Trend;
  tone: "accent" | "pass" | "warn" | "muted";
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
        {trend.current.toLocaleString()}
      </p>
      <p className="mt-1 flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <TrendChip trend={trend} />
        <span>from {trend.previous.toLocaleString()}</span>
      </p>
    </div>
  );
}

function directionClass(direction: TrendDirection) {
  if (direction === "up") return "bg-green-500/10 text-green-600";
  if (direction === "down") return "bg-red-500/10 text-red-600";
  return "bg-[var(--color-border)] text-[var(--color-muted)]";
}

function analyticsHref(days: Range, organizationId: string | null) {
  const params = new URLSearchParams();
  if (days !== DEFAULT_RANGE) params.set("days", String(days));
  if (organizationId) params.set("org", organizationId);
  const query = params.toString();
  return `/dashboard/analytics${query ? `?${query}` : ""}`;
}

function parseRange(value: string | undefined): Range {
  const parsed = Number(value);
  return (RANGES as readonly number[]).includes(parsed)
    ? (parsed as Range)
    : DEFAULT_RANGE;
}

function emptyTotals(): ProjectTotals {
  return { events: 0, ai: 0, bots: 0, prevEvents: 0, prevAi: 0, prevBots: 0 };
}

function sumTotals(all: Iterable<ProjectTotals>): ProjectTotals {
  const out = emptyTotals();
  for (const t of all) {
    out.events += t.events;
    out.ai += t.ai;
    out.bots += t.bots;
    out.prevEvents += t.prevEvents;
    out.prevAi += t.prevAi;
    out.prevBots += t.prevBots;
  }
  return out;
}

// Everything that isn't an AI referral or a bot crawl, matching the split the
// per-project stats page uses.
function otherVisits(events: number, ai: number, bots: number) {
  return Math.max(0, events - ai - bots);
}

function buildProjectAccessFilter(
  userId: string,
  projectMemberIds: string[],
  orgWideIds: string[],
) {
  const clauses = [`owner_id.eq.${userId}`];
  if (projectMemberIds.length > 0)
    clauses.push(`id.in.(${projectMemberIds.join(",")})`);
  if (orgWideIds.length > 0)
    clauses.push(`organization_id.in.(${orgWideIds.join(",")})`);
  return clauses.join(",");
}

function topDeviceItems(
  rows: Array<{ device_type: string; browser: string; os: string; count: number }>,
  labelFor: (row: {
    device_type: string;
    browser: string;
    os: string;
    count: number;
  }) => string,
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
