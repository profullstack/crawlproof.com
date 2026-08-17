import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { EditUrlForm } from "../edit-url-form";
import { DeleteProjectButton } from "../delete-project-button";

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, url")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  return (
    <div className="space-y-6">
      {/* Site URL — fix a domain typo without recreating the project. */}
      <section className="card p-4">
        <h2 className="text-lg font-semibold">Site URL</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          The domain this project audits. Editing it also re-points any
          connected autoblog config.
        </p>
        <p className="mt-2 break-all text-sm">{project.url}</p>
        <div className="mt-3">
          <EditUrlForm
            projectId={project.id}
            initialUrl={project.url}
            initialName={project.name}
          />
        </div>
      </section>

      {/* Danger zone */}
      <section className="border-t border-[var(--color-border)] pt-4">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Danger zone
        </h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Deletes the project and everything attached to it: audits,
          autoblog config, queued keywords, article history, and
          social-binding overrides. Connected social accounts (which
          are global per-user) are NOT deleted.
        </p>
        <div className="mt-2">
          <DeleteProjectButton projectId={project.id} />
        </div>
      </section>
    </div>
  );
}
