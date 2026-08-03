// Hosted, server-rendered job board for a project: /c/<project_id>
//
// The widget paints the customer's own /careers page client-side, which is
// exactly what crawlers can't read. This page is the crawlable counterpart —
// real HTML plus a JobPosting graph — so Google for Jobs and answer engines
// have something to index no matter how the customer's site is built.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { env } from "@/lib/env";
import { jobPostingJsonLd, workplaceSummary } from "@/lib/careers/jobs";
import { displayHost, loadBoard } from "@/lib/careers/board";

export const revalidate = 300;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ project: string }>;
}): Promise<Metadata> {
  const { project: projectId } = await params;
  const board = await loadBoard(projectId);
  if (!board) return { title: "Careers" };
  return {
    title: `Careers at ${board.project.name}`,
    description: `${board.jobs.length} open role${board.jobs.length === 1 ? "" : "s"} at ${board.project.name}.`,
    alternates: { canonical: `${env.siteUrl}/c/${projectId}` },
  };
}

export default async function HostedBoardPage({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project: projectId } = await params;
  const board = await loadBoard(projectId);
  if (!board) notFound();

  const { project, jobs } = board;
  const graph = jobs.map((job) =>
    jobPostingJsonLd({
      job,
      siteUrl: env.siteUrl,
      projectId,
      projectName: project.name,
      projectUrl: project.url,
    }),
  );

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 space-y-6">
      {graph.length > 0 && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({ "@context": "https://schema.org", "@graph": graph }),
          }}
        />
      )}

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Careers at {project.name}</h1>
        <p className="text-sm text-[var(--color-muted)]">
          {jobs.length === 0
            ? "No open roles right now."
            : `${jobs.length} open role${jobs.length === 1 ? "" : "s"}.`}{" "}
          <a
            href={project.url}
            className="underline hover:text-[var(--color-foreground)]"
            rel="noreferrer"
          >
            Visit {displayHost(project.url)}
          </a>
        </p>
      </header>

      <ul className="space-y-3">
        {jobs.map((job) => (
          <li key={job.id} className="card p-4">
            <h2 className="font-semibold">
              <Link href={`/c/${projectId}/${job.slug}`} className="hover:underline">
                {job.title}
              </Link>
            </h2>
            <p className="text-xs text-[var(--color-muted)]">
              {[
                job.department,
                workplaceSummary(job.workplace, job.location),
                job.employment_type,
                job.compensation,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {job.overview && (
              <p className="mt-2 text-sm line-clamp-3">{job.overview}</p>
            )}
          </li>
        ))}
      </ul>

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
