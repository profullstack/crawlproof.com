import { notFound } from "next/navigation";
import { serviceClient } from "@/lib/supabase/service";
import { PublicInviteForm } from "./form";

export const metadata = {
  title: "Get a survey invitation · CrawlProof",
  robots: { index: false, follow: false },
};

export default async function SurveyInvitePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const svc = serviceClient();
  const { data: survey } = await svc.from("surveys")
    .select("title, question, answer_type, status, project_id")
    .eq("slug", slug)
    .maybeSingle();
  if (!survey) notFound();
  const { data: project } = await svc.from("projects").select("name").eq("id", survey.project_id).maybeSingle();
  const active = survey.status === "live";

  return (
    <main className="mx-auto max-w-xl px-4 py-14 sm:px-6">
      <div className="card space-y-5 p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-accent)]">CrawlProof Survey</p>
        <h1 className="text-3xl font-bold">{survey.title}</h1>
        <p className="text-sm text-[var(--color-muted)]">{survey.question}</p>
        {active ? <PublicInviteForm slug={slug} siteName={project?.name ?? "this site"} /> : <p className="rounded border border-[var(--color-border)] p-4 text-sm text-[var(--color-muted)]">This survey is paused and is not accepting new invitations.</p>}
        <p className="border-t border-[var(--color-border)] pt-4 text-xs leading-relaxed text-[var(--color-muted)]">Your email or phone is used only for the survey invitation channel you select. SMS is sent only with your explicit permission. Email is used as a fallback only when you separately allow it.</p>
      </div>
    </main>
  );
}
