import { notFound } from "next/navigation";
import { serviceClient } from "@/lib/supabase/service";
import { SurveyResponseForm } from "./form";

export const metadata = {
  title: "Survey response · CrawlProof",
  robots: { index: false, follow: false },
};

export default async function SurveyResponsePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/.test(token)) notFound();
  const svc = serviceClient();
  const { data: invite } = await svc.from("survey_invites")
    .select("id, survey_id, delivery_status")
    .eq("invite_token", token)
    .maybeSingle();
  if (!invite || (invite.delivery_status !== "sent" && invite.delivery_status !== "responded")) notFound();
  const [{ data: survey }, { data: response }] = await Promise.all([
    svc.from("surveys").select("title, question, answer_type").eq("id", invite.survey_id).maybeSingle(),
    svc.from("survey_responses").select("id").eq("invite_id", invite.id).maybeSingle(),
  ]);
  if (!survey) notFound();

  return (
    <main className="mx-auto max-w-xl px-4 py-14 sm:px-6">
      <div className="card space-y-5 p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-accent)]">CrawlProof Survey</p>
        <h1 className="text-3xl font-bold">{survey.title}</h1>
        {response ? <p className="rounded border border-[var(--color-border)] p-4 text-sm">Thanks for sharing your feedback.</p> : <>
          <h2 className="text-lg font-medium">{survey.question}</h2>
          <SurveyResponseForm token={token} answerType={survey.answer_type} />
        </>}
      </div>
    </main>
  );
}
