import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ScoreBadge } from "@/components/score-badge";

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
      .select("id,name,url,schedule,next_run_at,status")
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
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold">{p.name}</div>
                    <div className="flex items-center gap-1.5">
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
                  <div className="mt-1 truncate text-sm text-[var(--color-muted)]">
                    {p.url}
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
