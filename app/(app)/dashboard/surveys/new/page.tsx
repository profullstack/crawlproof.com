import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { listUserOrgs } from "@/lib/orgs";
import { NewSurveyForm, type SurveyProjectOption } from "./form";

export const metadata = { title: "New survey · CrawlProof" };

export default async function NewSurveyPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const owned = (await listUserOrgs(supabase, user.id)).filter((org) => org.role === "owner" && org.id);
  const orgIds = owned.map((org) => org.id);
  const { data: rows } = orgIds.length
    ? await serviceClient().from("projects").select("id, name, url, organization_id")
        .in("organization_id", orgIds).in("status", ["active", "paused"]).order("name")
    : { data: [] };
  const projects = (rows ?? []) as SurveyProjectOption[];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/dashboard/surveys" className="text-sm text-[var(--color-muted)]">← Surveys</Link>
        <h1 className="mt-3 text-3xl font-bold">Create a survey</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">One question, two invitation versions. Each workspace can use the projects already registered in its CrawlProof site list.</p>
      </div>
      {projects.length ? <NewSurveyForm projects={projects} /> : (
        <section className="card p-6">
          <p className="text-sm text-[var(--color-muted)]">Add a site to your workspace before creating a survey.</p>
          <Link href="/dashboard/projects/new" className="btn btn-primary mt-4">Add a site</Link>
        </section>
      )}
    </div>
  );
}
