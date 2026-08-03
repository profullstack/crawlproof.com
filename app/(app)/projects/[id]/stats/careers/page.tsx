import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import type { ApplicationStatus, JobStatus, Workplace } from "@/lib/careers/jobs";
import { StatsSubnav } from "../stats-subnav";
import { CareersToggle } from "../careers-toggle";
import { JobManager, type JobRow } from "./job-manager";
import { Applications, type ApplicationRow } from "./applications";

type JobRecord = {
  id: string;
  slug: string;
  title: string;
  department: string | null;
  location: string | null;
  employment_type: string;
  workplace: Workplace;
  compensation: string | null;
  apply_url: string | null;
  overview: string | null;
  responsibilities: string[] | null;
  qualifications: string[] | null;
  status: JobStatus;
  sort_order: number;
  credit_charged_at: string | null;
};

type ApplicationRecord = {
  id: string;
  job_id: string;
  full_name: string;
  email: string;
  link: string | null;
  status: ApplicationStatus;
  created_at: string;
};

export default async function CareersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, url, tracker_enabled, careers_enabled")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  const [{ data: jobData }, { data: appData }] = await Promise.all([
    supabase
      .from("job_postings")
      .select(
        "id, slug, title, department, location, employment_type, workplace, compensation, apply_url, overview, responsibilities, qualifications, status, sort_order, credit_charged_at",
      )
      .eq("project_id", id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false }),
    supabase
      .from("job_applications")
      .select("id, job_id, full_name, email, link, status, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  const applicationRecords = (appData ?? []) as ApplicationRecord[];

  const countsByJob = new Map<string, number>();
  for (const app of applicationRecords) {
    countsByJob.set(app.job_id, (countsByJob.get(app.job_id) ?? 0) + 1);
  }

  const jobs: JobRow[] = ((jobData ?? []) as JobRecord[]).map((job) => ({
    ...job,
    responsibilities: job.responsibilities ?? [],
    qualifications: job.qualifications ?? [],
    credit_charged: Boolean(job.credit_charged_at),
    application_count: countsByJob.get(job.id) ?? 0,
  }));

  const titleByJob = new Map(jobs.map((job) => [job.id, job.title]));
  const applications: ApplicationRow[] = applicationRecords.map((app) => ({
    ...app,
    job_title: titleByJob.get(app.job_id) ?? "Deleted role",
  }));

  const trackerEnabled = Boolean(project.tracker_enabled);
  const careersEnabled = Boolean(project.careers_enabled);
  const hostedBoardUrl = `${env.siteUrl.replace(/\/+$/, "")}/c/${id}`;

  return (
    <div className="space-y-6">
      <StatsSubnav projectId={id} />

      <section className="card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Careers widget</h2>
            <p className="text-sm text-[var(--color-muted)]">
              {careersEnabled
                ? "Loaded. Your stats snippet paints the job board on /careers."
                : "Not loaded. Turn it on to publish roles through the snippet you already installed."}
            </p>
          </div>
          <CareersToggle projectId={id} initialEnabled={careersEnabled} />
        </div>

        {!trackerEnabled && (
          <p className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-muted)]">
            The careers widget loads through the stats tracker. Enable the tracker on
            the{" "}
            <a href={`/projects/${id}/stats`} className="underline">
              Stats overview
            </a>{" "}
            first.
          </p>
        )}

        {careersEnabled && (
          <div className="mt-3 space-y-2 text-sm text-[var(--color-muted)]">
            <p>
              No second script tag needed. On any page at{" "}
              <code className="font-mono">/careers</code> the tracker loads the widget
              automatically. To mount it somewhere else, drop this container on the page:
            </p>
            <pre className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs">
              {`<div data-cp-careers></div>`}
            </pre>
            <p>
              Using a different path? Add{" "}
              <code className="font-mono">data-careers-path=&quot;/jobs&quot;</code> to your
              stats script tag, or{" "}
              <code className="font-mono">data-careers=&quot;off&quot;</code> to suppress it.
            </p>
            <p>
              Every open role is also served as crawlable HTML with{" "}
              <code className="font-mono">JobPosting</code> schema at{" "}
              <a
                href={hostedBoardUrl}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-[var(--color-foreground)]"
              >
                your hosted board
              </a>
              , so answer engines can read it even though the widget paints client-side.
            </p>
          </div>
        )}
      </section>

      <JobManager projectId={id} jobs={jobs} hostedBoardUrl={hostedBoardUrl} />

      <Applications projectId={id} applications={applications} />
    </div>
  );
}
