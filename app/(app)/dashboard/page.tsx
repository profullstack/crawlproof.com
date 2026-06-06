import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ScoreBadge } from "@/components/score-badge";
import { FontSparkline } from "@/components/font-sparkline";
import { backfillProjectLogo } from "@/app/actions/createProject";
import { getOrCreateDefaultOrg, listUserOrgs } from "@/lib/orgs";
import {
  OrgDashboardControls,
  ProjectOrgMoveControl,
  type DashboardOrg,
} from "./org-controls";

export const metadata = { title: "Dashboard" };

type StatusFilter = "active" | "paused" | "archived";
type DashboardProject = {
  id: string;
  name: string;
  url: string;
  schedule: string;
  next_run_at: string | null;
  status: string;
  logo_url: string | null;
  organization_id?: string | null;
};

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
  { id: "archived", label: "Archived" },
];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; org?: string }>;
}) {
  const { status: statusParam, org: orgParam } = await searchParams;
  const status: StatusFilter =
    statusParam === "paused" || statusParam === "archived"
      ? statusParam
      : "active";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: memberRows } = await supabase
    .from("project_members")
    .select("project_id")
    .eq("user_id", user!.id);
  const memberIds = (memberRows ?? []).map((r: { project_id: string }) => r.project_id);
  const accessFilter =
    memberIds.length > 0
      ? `owner_id.eq.${user!.id},id.in.(${memberIds.join(",")})`
      : null;

  let orgs = await listUserOrgs(supabase, user!.id);
  if (orgs.length === 0) {
    const org = await getOrCreateDefaultOrg({
      userId: user!.id,
      email: user!.email,
    });
    orgs = org.id ? [org] : [];
  }
  const selectedOrg =
    orgs.find((org) => org.id === orgParam) ?? orgs[0] ?? null;
  const selectedOrgId = selectedOrg?.id ?? null;
  const orgSchemaReady = orgs.length > 0;

  const projectColumns = orgSchemaReady
    ? "id,name,url,schedule,next_run_at,status,logo_url,organization_id"
    : "id,name,url,schedule,next_run_at,status,logo_url";

  const projectsQuery = supabase
    .from("projects")
    .select(projectColumns)
    .eq("status", status)
    .order("created_at", { ascending: false });

  const scopedProjectsQuery = selectedOrgId
    ? projectsQuery.eq("organization_id", selectedOrgId)
    : accessFilter
      ? projectsQuery.or(accessFilter)
      : projectsQuery.eq("owner_id", user!.id);

  const [{ data: projectsRaw }, { data: audits }, counts] = await Promise.all([
    scopedProjectsQuery,
    supabase
      .from("audits")
      .select("id,target_url,status,score,created_at,share_token")
      .eq("owner_id", user!.id)
      .order("created_at", { ascending: false })
      .limit(10),
    countByStatus(supabase, user!.id, accessFilter, selectedOrgId),
  ]);
  const projects = ((projectsRaw ?? []) as unknown) as DashboardProject[];

  // Per-project autoblog/social enablement. Autoblog is "on" when the
  // project has an lx_site row in status=active; social is "on" when at
  // least one social account is linked at the project level.
  const projectIds = (projects ?? []).map((p) => p.id);
  const [autoblogIds, socialIds, latestPosts, trafficByProject] = await Promise.all([
    fetchEnabledProjectIds(supabase, "lx_site", projectIds, { status: "active" }),
    fetchEnabledProjectIds(supabase, "sp_site_account", projectIds),
    fetchLatestBlogPostByProject(supabase, projectIds),
    fetchSevenDayPageviews(supabase, projectIds),
  ]);

  // Lazy backfill: any project still missing a logo gets one scraped
  // in the background on this dashboard hit. Fire-and-forget — the
  // tile shows a letter avatar until the next render after the write
  // lands, so a slow third-party fetch never delays the page.
  for (const p of projects ?? []) {
    if (!(p as { logo_url: string | null }).logo_url) {
      void backfillProjectLogo(p.id, p.url);
    }
  }

  return (
    <div className="space-y-10">
      <section className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <Link href="/projects/new" className="btn btn-primary">
          New project
        </Link>
      </section>

      {orgSchemaReady && (
        <OrgDashboardControls
          orgs={orgs as DashboardOrg[]}
          selectedOrgId={selectedOrgId}
        />
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Projects</h2>
          <div
            role="tablist"
            className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-1 text-sm"
          >
            {FILTERS.map((f) => {
              const active = f.id === status;
              const n = counts[f.id];
              return (
                <Link
                  key={f.id}
                  href={dashboardHref(f.id, selectedOrgId)}
                  role="tab"
                  aria-selected={active}
                  className={`rounded-md px-3 py-1 ${
                    active
                      ? "bg-[var(--color-bg)] font-semibold"
                      : "text-[var(--color-muted)]"
                  }`}
                >
                  {f.label}
                  {n > 0 && (
                    <span className="ml-1.5 text-xs text-[var(--color-muted)]">
                      {n}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>

        {projects && projects.length > 0 ? (
          <ul className="grid gap-3 md:grid-cols-2">
            {projects.map((p) => (
              <li key={p.id} className="card p-4">
                <Link href={`/projects/${p.id}`} className="block">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <ProjectLogo
                        url={(p as { logo_url: string | null }).logo_url}
                        name={p.name}
                      />
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{p.name}</div>
                        <div className="mt-0.5 truncate text-sm text-[var(--color-muted)]">
                          {p.url}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {autoblogIds.has(p.id) && (
                        <span
                          className="badge badge-pass"
                          title="Autoblog campaign is active for this project"
                        >
                          Autoblog on
                        </span>
                      )}
                      {socialIds.has(p.id) && (
                        <span
                          className="badge badge-pass"
                          title="At least one social account is connected"
                        >
                          Social on
                        </span>
                      )}
                      <span className="badge">{p.schedule}</span>
                      {p.status !== "active" && (
                        <span
                          className={
                            p.status === "paused"
                              ? "badge badge-warn"
                              : "badge badge-unknown"
                          }
                        >
                          {p.status}
                        </span>
                      )}
                    </div>
                  </div>
                </Link>
                {latestPosts.get(p.id) && (
                  <div className="mt-2 truncate text-xs text-[var(--color-muted)]">
                    Last blog post:{" "}
                    <a
                      href={latestPosts.get(p.id)!.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-[var(--color-fg)]"
                    >
                      {new Date(
                        latestPosts.get(p.id)!.publishedAt,
                      ).toLocaleDateString()}
                    </a>
                  </div>
                )}
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-3">
                  <div>
                    <div className="text-xs font-medium text-[var(--color-fg)]">
                      {totalTraffic(trafficByProject.get(p.id) ?? []).toLocaleString()} pageviews
                    </div>
                    <div className="text-[11px] text-[var(--color-muted)]">
                      Past 7 days
                    </div>
                  </div>
                  <FontSparkline samples={trafficSamples(trafficByProject.get(p.id))} />
                </div>
                {orgSchemaReady && (
                  <ProjectOrgMoveControl
                    projectId={p.id}
                    currentOrgId={(p as { organization_id?: string | null }).organization_id ?? null}
                    orgs={orgs as DashboardOrg[]}
                  />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[var(--color-muted)]">
            {status === "active" ? (
              <>
                No projects yet.{" "}
                <Link href="/projects/new" className="underline">
                  Create one
                </Link>
                .
              </>
            ) : (
              `No ${status} projects.`
            )}
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent audits</h2>
        {audits && audits.length > 0 ? (
          <ul className="space-y-2">
            {audits.map((a) => (
              <li key={a.id} className="card flex items-center justify-between p-3">
                <div>
                  <Link href={`/audits/${a.id}`} className="font-medium hover:underline">
                    {a.target_url}
                  </Link>
                  <div className="text-xs text-[var(--color-muted)]">
                    {new Date(a.created_at).toLocaleString()} · {a.status}
                  </div>
                </div>
                <ScoreBadge score={a.score} status={a.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[var(--color-muted)]">No audits yet.</p>
        )}
      </section>
    </div>
  );
}

function ProjectLogo({
  url,
  name,
}: {
  url: string | null;
  name: string;
}) {
  const letter = (name || "?").trim().charAt(0).toUpperCase();
  // 40px square; rounded corners; one-letter fallback when the site
  // either has no detectable logo or backfill hasn't run yet.
  if (!url) {
    return (
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--color-card)] text-sm font-semibold text-[var(--color-muted)]"
        aria-hidden
      >
        {letter}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      width={40}
      height={40}
      loading="lazy"
      className="h-10 w-10 shrink-0 rounded-md border border-[var(--color-border)] bg-white object-contain p-1"
    />
  );
}

type LatestPost = { url: string; publishedAt: string };
type TrafficPoint = { day: string; count: number };

async function fetchLatestBlogPostByProject(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectIds: string[],
): Promise<Map<string, LatestPost>> {
  const out = new Map<string, LatestPost>();
  if (projectIds.length === 0) return out;

  const { data: sites } = await supabase
    .from("lx_site")
    .select("id, project_id, blog_root_url")
    .in("project_id", projectIds);
  if (!sites || sites.length === 0) return out;

  const siteToProject = new Map<string, { projectId: string; blogRoot: string }>();
  for (const s of sites as { id: string; project_id: string; blog_root_url: string }[]) {
    siteToProject.set(s.id, { projectId: s.project_id, blogRoot: s.blog_root_url });
  }

  const { data: articles } = await supabase
    .from("lx_article")
    .select("site_id, slug, published_at")
    .in("site_id", Array.from(siteToProject.keys()))
    .eq("status", "published")
    .not("published_at", "is", null)
    .order("published_at", { ascending: false });
  if (!articles) return out;

  for (const a of articles as { site_id: string; slug: string; published_at: string }[]) {
    const site = siteToProject.get(a.site_id);
    if (!site) continue;
    if (out.has(site.projectId)) continue;
    const root = site.blogRoot.replace(/\/$/, "");
    out.set(site.projectId, {
      url: `${root}/${a.slug}`,
      publishedAt: a.published_at,
    });
  }
  return out;
}

async function fetchSevenDayPageviews(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectIds: string[],
): Promise<Map<string, TrafficPoint[]>> {
  const days = lastSevenDays();
  const out = new Map<string, TrafficPoint[]>();
  for (const projectId of projectIds) {
    out.set(
      projectId,
      days.map((day) => ({ day, count: 0 })),
    );
  }
  if (projectIds.length === 0) return out;

  // Server-side aggregator — selecting raw rows runs into PostgREST's
  // 1000-row response cap and silently truncates whichever projects'
  // rows didn't make the cut.
  const { data } = await supabase.rpc("dashboard_project_pageviews", {
    p_project_ids: projectIds,
    p_since: days[0],
  });

  for (const row of (data ?? []) as Array<{
    project_id: string;
    day: string;
    count: number;
  }>) {
    const points = out.get(row.project_id);
    if (!points) continue;
    const point = points.find((item) => item.day === row.day);
    if (point) point.count += Number(row.count);
  }

  return out;
}

function lastSevenDays() {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - (6 - index));
    return date.toISOString().slice(0, 10);
  });
}

function trafficSamples(points: TrafficPoint[] | undefined) {
  return points?.map((point) => point.count) ?? Array(7).fill(0);
}

function totalTraffic(points: TrafficPoint[]) {
  return points.reduce((sum, point) => sum + point.count, 0);
}

function dashboardHref(status: StatusFilter, organizationId: string | null) {
  const params = new URLSearchParams();
  if (status !== "active") params.set("status", status);
  if (organizationId) params.set("org", organizationId);
  const query = params.toString();
  return `/dashboard${query ? `?${query}` : ""}`;
}

async function fetchEnabledProjectIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: "lx_site" | "sp_site_account",
  projectIds: string[],
  filters: Record<string, string> = {},
): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();
  let q = supabase.from(table).select("project_id").in("project_id", projectIds);
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { data } = await q;
  return new Set((data ?? []).map((r: { project_id: string }) => r.project_id));
}

async function countByStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ownerId: string,
  accessFilter: string | null,
  organizationId: string | null,
): Promise<Record<StatusFilter, number>> {
  const rows = await Promise.all(
    FILTERS.map(async (f) => {
      let q = supabase
        .from("projects")
        .select("id", { count: "exact", head: true })
        .eq("status", f.id);
      q = organizationId
        ? q.eq("organization_id", organizationId)
        : accessFilter
          ? q.or(accessFilter)
          : q.eq("owner_id", ownerId);
      const { count } = await q;
      return [f.id, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(rows) as Record<StatusFilter, number>;
}
