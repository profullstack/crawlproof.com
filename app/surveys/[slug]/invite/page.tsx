import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { env } from "@/lib/env";
import { createSeoAeoMetadata, serializeJsonLd } from "@/lib/seo/seo-aeo-meta";
import { serviceClient } from "@/lib/supabase/service";
import { PublicInviteForm } from "./form";

const loadSurveyInvite = cache(async (slug: string) => {
  const svc = serviceClient();
  const { data: survey } = await svc.from("surveys")
    .select("title, question, status, project_id")
    .eq("slug", slug)
    .maybeSingle();
  if (!survey) return null;
  const { data: project } = await svc.from("projects")
    .select("name")
    .eq("id", survey.project_id)
    .maybeSingle();
  return { survey, projectName: project?.name?.trim() || "this site" };
});

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const context = await loadSurveyInvite(slug);
  if (!context) {
    return createSeoAeoMetadata({
      title: "Survey invitation not found · CrawlProof",
      description: "This survey invitation is no longer available.",
      robots: { index: false, follow: false },
    });
  }

  const { survey, projectName } = context;
  const title = `${survey.title} · ${projectName}`;
  const description = survey.status === "live"
    ? `${projectName} is asking for feedback: ${survey.question}`
    : `This survey from ${projectName} is paused.`;

  return createSeoAeoMetadata({
    title,
    description,
    url: `${env.siteUrl.replace(/\/$/, "")}/surveys/${slug}/invite`,
    robots: { index: false, follow: false },
    socialCard: "summary_large_image",
  });
}

export default async function SurveyInvitePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const context = await loadSurveyInvite(slug);
  if (!context) notFound();
  const { survey, projectName } = context;
  const active = survey.status === "live";
  const pageUrl = `${env.siteUrl.replace(/\/$/, "")}/surveys/${slug}/invite`;
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: survey.title,
    description: survey.question,
    url: pageUrl,
    isPartOf: { "@type": "WebSite", name: "CrawlProof", url: env.siteUrl },
    mainEntity: { "@type": "Question", text: survey.question },
  };

  return (
    <main className="mx-auto max-w-xl px-4 py-14 sm:px-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }} />
      <div className="card space-y-5 p-6 sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-accent)]">CrawlProof Survey</p>
        <h1 className="text-3xl font-bold">{survey.title}</h1>
        <p className="text-sm text-[var(--color-muted)]">{survey.question}</p>
        {active ? <PublicInviteForm slug={slug} siteName={projectName} /> : <p className="rounded border border-[var(--color-border)] p-4 text-sm text-[var(--color-muted)]">This survey is paused and is not accepting new invitations.</p>}
        <p className="border-t border-[var(--color-border)] pt-4 text-xs leading-relaxed text-[var(--color-muted)]">Your email or phone is used only for the survey invitation channel you select. SMS is sent only with your explicit permission. Email is used as a fallback only when you separately allow it.</p>
      </div>
    </main>
  );
}
