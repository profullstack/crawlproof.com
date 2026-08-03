// Canonical, server-rendered page for one posting: /c/<project_id>/<slug>
//
// This is the stable address a job keeps for its whole life, and the URL the
// JobPosting schema points at. Applying still happens on the customer's own
// site — we link back rather than duplicating the form here.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { env } from "@/lib/env";
import { jobPostingJsonLd, workplaceSummary } from "@/lib/careers/jobs";
import { displayHost, loadBoard } from "@/lib/careers/board";

export const revalidate = 300;

async function load(projectId: string, slug: string) {
  const board = await loadBoard(projectId);
  if (!board) return null;
  const job = board.jobs.find((j) => j.slug === slug);
  if (!job) return null;
  return { project: board.project, job };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ project: string; slug: string }>;
}): Promise<Metadata> {
  const { project: projectId, slug } = await params;
  const found = await load(projectId, slug);
  if (!found) return { title: "Role not found" };
  return {
    title: `${found.job.title} — ${found.project.name}`,
    description:
      found.job.overview?.slice(0, 200) ??
      `${found.job.title} at ${found.project.name}.`,
    alternates: { canonical: `${env.siteUrl}/c/${projectId}/${slug}` },
  };
}

export default async function HostedJobPage({
  params,
}: {
  params: Promise<{ project: string; slug: string }>;
}) {
  const { project: projectId, slug } = await params;
  const found = await load(projectId, slug);
  if (!found) notFound();

  const { project, job } = found;
  const jsonLd = jobPostingJsonLd({
    job,
    siteUrl: env.siteUrl,
    projectId,
    projectName: project.name,
    projectUrl: project.url,
  });

  // Where an applicant actually applies: the role's own external URL if it has
  // one, otherwise the customer's careers page with the job's anchor.
  const applyHref =
    job.apply_url ?? `${project.url.replace(/\/+$/, "")}/careers#cp-job-${job.slug}`;

  const meta = [
    job.department,
    workplaceSummary(job.workplace, job.location),
    job.employment_type,
    job.compensation,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 space-y-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <nav className="text-sm">
        <Link href={`/c/${projectId}`} className="underline text-[var(--color-muted)]">
          ← All roles at {project.name}
        </Link>
      </nav>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{job.title}</h1>
        <p className="text-sm text-[var(--color-muted)]">{meta}</p>
      </header>

      {job.overview && (
        <section className="space-y-2">
          <h2 className="font-semibold">Role Overview</h2>
          {job.overview.split(/\n{2,}/).map((para, i) => (
            <p key={i} className="text-sm">
              {para}
            </p>
          ))}
        </section>
      )}

      {job.responsibilities.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Key Responsibilities</h2>
          <ul className="list-disc pl-5 text-sm space-y-1">
            {job.responsibilities.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {job.qualifications.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Minimum Qualifications</h2>
          <ul className="list-disc pl-5 text-sm space-y-1">
            {job.qualifications.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      <p>
        <a
          href={applyHref}
          className="btn btn-primary"
          rel="noreferrer"
          target="_blank"
        >
          Apply on {displayHost(project.url)}
        </a>
      </p>

      <p className="text-xs text-[var(--color-muted)]">
        Job board by{" "}
        <a href={env.siteUrl} className="underline">
          CrawlProof
        </a>
        .
      </p>
    </main>
  );
}
