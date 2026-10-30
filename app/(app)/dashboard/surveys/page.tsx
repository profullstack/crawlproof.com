import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { listUserOrgs } from "@/lib/orgs";

export const metadata = { title: "Surveys · CrawlProof" };

export default async function SurveysPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const orgs = await listUserOrgs(supabase, user.id);
  const owned = orgs.filter((org) => org.role === "owner");
  const orgIds = owned.map((org) => org.id).filter(Boolean);
  const svc = serviceClient();
  const { data: rows } = orgIds.length
    ? await svc.from("surveys")
        .select("id, organization_id, project_id, title, question, status, created_at")
        .in("organization_id", orgIds)
        .order("created_at", { ascending: false })
    : { data: [] };
  const surveys = (rows ?? []) as Array<{
    id: string;
    organization_id: string;
    project_id: string;
    title: string;
    question: string;
    status: string;
    created_at: string;
  }>;
  const projectIds = [...new Set(surveys.map((survey) => survey.project_id))];
  const { data: projectRows } = projectIds.length
    ? await svc.from("projects").select("id, name, url").in("id", projectIds)
    : { data: [] };
  const projects = new Map(((projectRows ?? []) as Array<{ id: string; name: string; url: string }>).map((project) => [project.id, project]));

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-accent)]">Feedback</p>
          <h1 className="mt-2 text-3xl font-bold">Surveys</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">
            Ask one focused question across the sites in your workspace. Compare invitation copy, collect responses, and send by email or SMS when people opt in.
          </p>
        </div>
        {owned.length > 0 && (
          <Link href="/dashboard/surveys/new" className="btn btn-primary">New survey</Link>
        )}
      </header>

      {owned.length === 0 ? (
        <section className="card p-6">
          <h2 className="text-lg font-semibold">Workspace owner access needed</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">Surveys use the workspace sender settings and site directory, so only workspace owners can create and send them.</p>
        </section>
      ) : surveys.length === 0 ? (
        <section className="card p-8 text-center">
          <h2 className="text-xl font-semibold">Start with one question</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--color-muted)]">Create a survey for one of your sites, write two invitation versions, then share the opt-in link or send it to someone who agreed to participate.</p>
          <Link href="/dashboard/surveys/new" className="btn btn-primary mt-5">Create your first survey</Link>
        </section>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {surveys.map((survey) => {
            const project = projects.get(survey.project_id);
            return (
              <Link key={survey.id} href={`/dashboard/surveys/${survey.id}`} className="card block p-5 transition hover:border-[var(--color-accent)]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">{survey.title}</h2>
                    <p className="mt-1 text-sm text-[var(--color-muted)]">{project?.name ?? "Site"}</p>
                  </div>
                  <span className={`badge ${survey.status === "live" ? "badge-pass" : ""}`}>{survey.status}</span>
                </div>
                <p className="mt-4 line-clamp-2 text-sm">{survey.question}</p>
                <p className="mt-4 text-xs text-[var(--color-muted)]">{project?.url ?? ""} · created {new Date(survey.created_at).toLocaleDateString()}</p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
