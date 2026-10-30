import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { SurveyStatusButton } from "./status-button";
import { SurveyInviteForm } from "./send-invite-form";

export const metadata = { title: "Survey results · CrawlProof" };

export default async function SurveyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const svc = serviceClient();
  const { data: survey } = await svc.from("surveys")
    .select("id, organization_id, project_id, slug, title, question, answer_type, status, variants, created_at")
    .eq("id", id)
    .maybeSingle();
  if (!survey) notFound();
  const { data: owner } = await svc.from("organization_members")
    .select("id")
    .eq("organization_id", survey.organization_id)
    .eq("user_id", user.id)
    .eq("role", "owner")
    .maybeSingle();
  if (!owner) notFound();

  const [{ data: project }, { data: inviteRows }, { data: responseRows }] = await Promise.all([
    svc.from("projects").select("name, url").eq("id", survey.project_id).maybeSingle(),
    svc.from("survey_invites").select("id, variant_key, email_consent, sms_consent, requested_channel, delivery_channel, delivery_status, delivery_error, created_at").eq("survey_id", id).order("created_at", { ascending: false }).limit(500),
    svc.from("survey_responses").select("id, invite_id, variant_key, rating, answer_text, created_at").eq("survey_id", id).order("created_at", { ascending: false }).limit(500),
  ]);
  const invites = (inviteRows ?? []) as Array<{
    id: string; variant_key: string;
    email_consent: boolean; sms_consent: boolean; requested_channel: string; delivery_channel: string | null;
    delivery_status: string; delivery_error: string | null; created_at: string;
  }>;
  const responses = (responseRows ?? []) as Array<{
    id: string; invite_id: string; variant_key: string; rating: number | null;
    answer_text: string | null; created_at: string;
  }>;
  const responseByInvite = new Map(responses.map((response) => [response.invite_id, response]));
  const variants = (Array.isArray(survey.variants) ? survey.variants : []) as Array<{ key: string; subject: string; message: string }>;
  const inviteUrl = `${process.env.NEXT_PUBLIC_SITE_URL ?? "https://crawlproof.com"}/surveys/${survey.slug}/invite`;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <Link href="/dashboard/surveys" className="text-sm text-[var(--color-muted)]">← Surveys</Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-bold">{survey.title}</h1>
              <span className={`badge ${survey.status === "live" ? "badge-pass" : ""}`}>{survey.status}</span>
            </div>
            <p className="mt-2 text-sm text-[var(--color-muted)]">{project?.name ?? "Site"} · {project?.url ?? ""}</p>
            <p className="mt-4 text-lg">{survey.question}</p>
          </div>
          <SurveyStatusButton surveyId={survey.id} status={survey.status} />
        </div>
      </div>

      <section className="card space-y-3 p-5">
        <div>
          <h2 className="text-lg font-semibold">Opt-in link</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">Share this link where people can choose email, SMS, or both. Each channel requires a separate opt-in.</p>
        </div>
        <a href={inviteUrl} target="_blank" rel="noreferrer" className="block break-all rounded border border-[var(--color-border)] p-3 font-mono text-sm text-[var(--color-accent)] underline">{inviteUrl}</a>
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-semibold">Send one invitation</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">Use this when someone gives you their contact details and agrees to a survey invite. If SMS fails, email is used only when email consent is also checked.</p>
        <SurveyInviteForm slug={survey.slug} />
      </section>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-end justify-between gap-3 p-5">
          <div>
            <h2 className="text-lg font-semibold">Invitation A/B test</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">Stable recipient assignment · question stays the same between variants</p>
          </div>
          <p className="text-sm text-[var(--color-muted)]">{responses.length} response{responses.length === 1 ? "" : "s"} · {invites.length} invitation{invites.length === 1 ? "" : "s"}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wider text-[var(--color-muted)]">
              <tr><th className="px-5 py-3">Variant</th><th className="px-3 py-3 text-right">Invited</th><th className="px-3 py-3 text-right">Delivered</th><th className="px-3 py-3 text-right">Responses</th><th className="px-5 py-3 text-right">Response rate</th></tr>
            </thead>
            <tbody>
              {variants.map((variant) => {
                const assigned = invites.filter((invite) => invite.variant_key === variant.key);
                const delivered = assigned.filter((invite) => invite.delivery_status === "sent" || invite.delivery_status === "responded").length;
                const answered = responses.filter((response) => response.variant_key === variant.key).length;
                const rate = delivered ? `${Math.round((answered / delivered) * 100)}%` : "—";
                return (
                  <tr key={variant.key} className="border-t border-[var(--color-border)] align-top">
                    <td className="max-w-md px-5 py-4"><strong>{variant.key}</strong><p className="mt-1 text-xs text-[var(--color-muted)]">{variant.message}</p></td>
                    <td className="px-3 py-4 text-right tabular-nums">{assigned.length}</td>
                    <td className="px-3 py-4 text-right tabular-nums">{delivered}</td>
                    <td className="px-3 py-4 text-right tabular-nums">{answered}</td>
                    <td className="px-5 py-4 text-right tabular-nums">{rate}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="p-5"><h2 className="text-lg font-semibold">Responses</h2><p className="mt-1 text-sm text-[var(--color-muted)]">Contact details are not shown in the response list.</p></div>
        {responses.length === 0 ? <p className="px-5 pb-5 text-sm text-[var(--color-muted)]">No responses yet. Share the opt-in link or send an invitation.</p> : (
          <div className="divide-y divide-[var(--color-border)]">
            {responses.map((response) => {
              const invite = invites.find((row) => row.id === response.invite_id);
              return <div key={response.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                <div><span className="badge">Variant {response.variant_key}</span><p className="mt-2 whitespace-pre-wrap text-sm">{response.rating != null ? `${response.rating} / 5` : response.answer_text}</p></div>
                <time className="text-xs text-[var(--color-muted)]">{new Date(response.created_at).toLocaleString()}</time>
                {invite?.delivery_channel && <span className="text-xs text-[var(--color-muted)]">via {invite.delivery_channel}</span>}
              </div>;
            })}
          </div>
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="p-5"><h2 className="text-lg font-semibold">Invitation history</h2></div>
        {invites.length === 0 ? <p className="px-5 pb-5 text-sm text-[var(--color-muted)]">No invitations sent yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wider text-[var(--color-muted)]"><tr><th className="px-5 py-3">Recipient</th><th className="px-3 py-3">Variant</th><th className="px-3 py-3">Channel</th><th className="px-3 py-3">Status</th><th className="px-5 py-3">Sent</th></tr></thead>
            <tbody>{invites.map((invite) => <tr key={invite.id} className="border-t border-[var(--color-border)]">
              <td className="px-5 py-3">{invite.sms_consent && invite.email_consent ? "SMS + email fallback" : invite.sms_consent ? "SMS opt-in" : "Email opt-in"}</td>
              <td className="px-3 py-3">{invite.variant_key}</td><td className="px-3 py-3 capitalize">{invite.delivery_channel ?? invite.requested_channel}</td>
              <td className="px-3 py-3"><span className="badge">{invite.delivery_status}</span>{invite.delivery_error && <p className="mt-1 max-w-xs text-xs text-red-600">{invite.delivery_error}</p>}</td>
              <td className="px-5 py-3 text-xs text-[var(--color-muted)]">{new Date(invite.created_at).toLocaleString()}</td>
            </tr>)}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
