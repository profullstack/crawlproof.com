import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ScoreBadge } from "@/components/score-badge";
import { RunAuditButton } from "@/components/run-audit-button";
import { ScheduleToggle } from "@/components/schedule-toggle";

export default async function ProjectPage({
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

  const { data: audits } = await supabase
    .from("audits")
    .select("id,target_url,status,score,created_at")
    .eq("project_id", id)
    .order("created_at", { ascending: false });

  const last = audits?.[0];
  const prev = audits?.[1];

  return (
    <div className="space-y-8">
      <div>
        <Link href="/dashboard" className="text-sm text-[var(--color-muted)]">
          ← Dashboard
        </Link>
        <h1 className="mt-3 text-3xl font-bold">{project.name}</h1>
        <p className="mt-1 text-[var(--color-muted)]">{project.url}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <RunAuditButton projectId={project.id} url={project.url} />
        <ScheduleToggle projectId={project.id} current={project.schedule} />
        {last && prev && (
          <Link
            href={`/audits/${last.id}?diff=${prev.id}`}
            className="btn"
          >
            Diff vs previous
          </Link>
        )}
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Audit history</h2>
        {audits && audits.length > 0 ? (
          <ul className="space-y-2">
            {audits.map((a) => (
              <li key={a.id} className="card flex items-center justify-between p-3">
                <Link href={`/audits/${a.id}`} className="font-medium hover:underline">
                  {new Date(a.created_at).toLocaleString()}
                </Link>
                <ScoreBadge score={a.score} status={a.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[var(--color-muted)]">No audits yet. Run one above.</p>
        )}
      </section>
    </div>
  );
}
