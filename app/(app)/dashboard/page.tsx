import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ScoreBadge } from "@/components/score-badge";
import { backfillProjectLogo } from "@/app/actions/createProject";

export const metadata = { title: "Dashboard" };

type StatusFilter = "active" | "paused" | "archived";

const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
  { id: "archived", label: "Archived" },
];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: statusParam } = await searchParams;
  const status: StatusFilter =
    statusParam === "paused" || statusParam === "archived"
      ? statusParam
      : "active";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: projects }, { data: audits }, counts] = await Promise.all([
    supabase
      .from("projects")
      .select("id,name,url,schedule,next_run_at,status,logo_url")
      .eq("owner_id", user!.id)
      .eq("status", status)
      .order("created_at", { ascending: false }),
    supabase
      .from("audits")
      .select("id,target_url,status,score,created_at,share_token")
      .eq("owner_id", user!.id)
      .order("created_at", { ascending: false })
      .limit(10),
    countByStatus(supabase, user!.id),
  ]);

  // Per-project autoblog/social enablement. Autoblog is "on" when the
  // project has an lx_site row in status=active; social is "on" when at
  // least one social account is linked at the project level.
  const projectIds = (projects ?? []).map((p) => p.id);
  const [autoblogIds, socialIds] = await Promise.all([
    fetchEnabledProjectIds(supabase, "lx_site", projectIds, { status: "active" }),
    fetchEnabledProjectIds(supabase, "sp_site_account", projectIds),
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
                  href={f.id === "active" ? "/dashboard" : `/dashboard?status=${f.id}`}
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
): Promise<Record<StatusFilter, number>> {
  const rows = await Promise.all(
    FILTERS.map(async (f) => {
      const { count } = await supabase
        .from("projects")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", ownerId)
        .eq("status", f.id);
      return [f.id, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(rows) as Record<StatusFilter, number>;
}
