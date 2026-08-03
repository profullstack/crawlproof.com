"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteJobPosting,
  saveJobPosting,
  setJobStatus,
} from "@/app/actions/careers";
import {
  EMPLOYMENT_TYPES,
  WORKPLACES,
  WORKPLACE_LABEL,
  type JobStatus,
  type Workplace,
  workplaceSummary,
} from "@/lib/careers/jobs";

export interface JobRow {
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
  responsibilities: string[];
  qualifications: string[];
  status: JobStatus;
  sort_order: number;
  application_count: number;
}

const STATUS_LABEL: Record<JobStatus, string> = {
  draft: "Draft",
  open: "Open",
  closed: "Closed",
};

export function JobManager({
  projectId,
  jobs,
  hostedBoardUrl,
}: {
  projectId: string;
  jobs: JobRow[];
  hostedBoardUrl: string;
}) {
  const [editing, setEditing] = useState<JobRow | "new" | null>(null);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Job postings</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Open roles appear in the widget on your site and on your{" "}
            <a
              href={hostedBoardUrl}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-[var(--color-foreground)]"
            >
              hosted board
            </a>
            . Drafts stay private.
          </p>
        </div>
        {editing === null && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
            Add role
          </button>
        )}
      </div>

      {editing !== null && (
        <JobForm
          projectId={projectId}
          job={editing === "new" ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}

      {jobs.length === 0 && editing === null ? (
        <div className="card p-4">
          <p className="text-sm text-[var(--color-muted)]">
            No roles yet. Add one and set it to Open to publish it.
          </p>
        </div>
      ) : (
        jobs.map((job) => (
          <JobCard
            key={job.id}
            projectId={projectId}
            job={job}
            onEdit={() => setEditing(job)}
            busy={editing !== null}
          />
        ))
      )}
    </section>
  );
}

function JobCard({
  projectId,
  job,
  onEdit,
  busy,
}: {
  projectId: string;
  job: JobRow;
  onEdit: () => void;
  busy: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function changeStatus(status: JobStatus) {
    setError(null);
    startTransition(async () => {
      const res = await setJobStatus({ projectId, jobId: job.id, status });
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const res = await deleteJobPosting({ projectId, jobId: job.id });
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  const meta = [
    job.department,
    workplaceSummary(job.workplace, job.location),
    job.employment_type,
    job.compensation,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="card p-4 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="font-semibold">{job.title}</h3>
          <p className="text-xs text-[var(--color-muted)]">{meta || "No details set"}</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`rounded-full px-2 py-0.5 ${
              job.status === "open"
                ? "bg-green-500/15 text-green-600"
                : job.status === "draft"
                  ? "bg-yellow-500/15 text-yellow-700"
                  : "bg-[var(--color-bg)] text-[var(--color-muted)]"
            }`}
          >
            {STATUS_LABEL[job.status]}
          </span>
          <span className="text-[var(--color-muted)]">
            {job.application_count} application{job.application_count === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-secondary text-xs"
          onClick={onEdit}
          disabled={busy || pending}
        >
          Edit
        </button>
        {job.status !== "open" && (
          <button
            type="button"
            className="btn btn-secondary text-xs"
            onClick={() => changeStatus("open")}
            disabled={pending}
          >
            Publish
          </button>
        )}
        {job.status === "open" && (
          <button
            type="button"
            className="btn btn-secondary text-xs"
            onClick={() => changeStatus("closed")}
            disabled={pending}
          >
            Close
          </button>
        )}
        {confirming ? (
          <>
            <button
              type="button"
              className="btn btn-secondary text-xs text-red-600"
              onClick={remove}
              disabled={pending}
            >
              Delete for good
            </button>
            <button
              type="button"
              className="btn btn-secondary text-xs"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-secondary text-xs"
            onClick={() => setConfirming(true)}
            disabled={pending}
          >
            Delete
          </button>
        )}
      </div>
      {confirming && (
        <p className="text-xs text-[var(--color-muted)]">
          Deleting removes its {job.application_count} application
          {job.application_count === 1 ? "" : "s"} too.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function JobForm({
  projectId,
  job,
  onDone,
}: {
  projectId: string;
  job: JobRow | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await saveJobPosting({
        projectId,
        jobId: job?.id,
        title: String(formData.get("title") ?? ""),
        department: String(formData.get("department") ?? ""),
        location: String(formData.get("location") ?? ""),
        employmentType: String(formData.get("employmentType") ?? ""),
        workplace: String(formData.get("workplace") ?? "onsite") as Workplace,
        compensation: String(formData.get("compensation") ?? ""),
        applyUrl: String(formData.get("applyUrl") ?? ""),
        overview: String(formData.get("overview") ?? ""),
        responsibilities: String(formData.get("responsibilities") ?? ""),
        qualifications: String(formData.get("qualifications") ?? ""),
        status: String(formData.get("status") ?? "draft") as JobStatus,
        sortOrder: Number(formData.get("sortOrder") ?? 0),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <form action={submit} className="card p-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" required>
          <input name="title" defaultValue={job?.title ?? ""} required maxLength={200} className="input" />
        </Field>
        <Field label="Department">
          <input
            name="department"
            defaultValue={job?.department ?? ""}
            maxLength={120}
            placeholder="Engineering"
            className="input"
          />
        </Field>
        <Field label="Location">
          <input
            name="location"
            defaultValue={job?.location ?? ""}
            maxLength={160}
            placeholder="Austin, TX"
            className="input"
          />
        </Field>
        <Field label="Employment type">
          <select
            name="employmentType"
            defaultValue={job?.employment_type ?? "Full-time"}
            className="input"
          >
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Workplace">
          <select name="workplace" defaultValue={job?.workplace ?? "onsite"} className="input">
            {WORKPLACES.map((w) => (
              <option key={w} value={w}>
                {WORKPLACE_LABEL[w]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Compensation">
          <input
            name="compensation"
            defaultValue={job?.compensation ?? ""}
            maxLength={160}
            placeholder="$160k–$200k"
            className="input"
          />
        </Field>
        <Field label="Status">
          <select name="status" defaultValue={job?.status ?? "draft"} className="input">
            <option value="draft">Draft — not published</option>
            <option value="open">Open — live in the widget</option>
            <option value="closed">Closed — no longer accepting</option>
          </select>
        </Field>
      </div>

      <Field label="Role overview">
        <textarea
          name="overview"
          defaultValue={job?.overview ?? ""}
          rows={4}
          maxLength={8000}
          className="input"
        />
      </Field>

      <Field label="Key responsibilities" hint="One per line.">
        <textarea
          name="responsibilities"
          defaultValue={(job?.responsibilities ?? []).join("\n")}
          rows={4}
          className="input"
        />
      </Field>

      <Field label="Minimum qualifications" hint="One per line.">
        <textarea
          name="qualifications"
          defaultValue={(job?.qualifications ?? []).join("\n")}
          rows={4}
          className="input"
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="External apply URL"
          hint="Optional. Set this and the widget links out instead of showing the inline form."
        >
          <input
            name="applyUrl"
            defaultValue={job?.apply_url ?? ""}
            maxLength={500}
            placeholder="https://…"
            className="input"
          />
        </Field>
        <Field label="Sort order" hint="Lower sorts first.">
          <input
            name="sortOrder"
            type="number"
            defaultValue={job?.sort_order ?? 0}
            className="input"
          />
        </Field>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : job ? "Save changes" : "Create role"}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDone} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span>
        {label}
        {required && <span className="text-red-600"> *</span>}
      </span>
      {children}
      {hint && <span className="text-xs text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}
