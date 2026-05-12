import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ScoreBadge } from "@/components/score-badge";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: projects }, { data: audits }] = await Promise.all([
    supabase
      .from("projects")
      .select("id,name,url,schedule,next_run_at")
      .eq("owner_id", user!.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("audits")
      .select("id,target_url,status,score,created_at,share_token")
      .eq("owner_id", user!.id)
      .order("created_at", { ascending: false })
      .limit(10),
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
        <h2 className="mb-3 text-lg font-semibold">Projects</h2>
        {projects && projects.length > 0 ? (
          <ul className="grid gap-3 md:grid-cols-2">
            {projects.map((p) => (
              <li key={p.id} className="card p-4">
                <Link href={`/projects/${p.id}`} className="block">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold">{p.name}</div>
                    <span className="badge">{p.schedule}</span>
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
            No projects yet.{" "}
            <Link href="/projects/new" className="underline">
              Create one
            </Link>
            .
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
