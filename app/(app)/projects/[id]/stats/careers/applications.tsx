"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setApplicationStatus } from "@/app/actions/careers";
import {
  APPLICATION_STATUSES,
  APPLICATION_STATUS_LABEL,
  type ApplicationStatus,
} from "@/lib/careers/jobs";

export interface ApplicationRow {
  id: string;
  job_id: string;
  job_title: string;
  full_name: string;
  email: string;
  link: string | null;
  status: ApplicationStatus;
  created_at: string;
}

const STATUS_STYLE: Record<ApplicationStatus, string> = {
  new: "bg-blue-500/15 text-blue-600",
  shortlisted: "bg-yellow-500/15 text-yellow-700",
  accepted: "bg-green-500/15 text-green-600",
  rejected: "bg-[var(--color-bg)] text-[var(--color-muted)]",
};

export function Applications({
  projectId,
  applications,
}: {
  projectId: string;
  applications: ApplicationRow[];
}) {
  const [filter, setFilter] = useState<ApplicationStatus | "all">("all");
  const [job, setJob] = useState<string>("all");

  const jobs = Array.from(
    new Map(applications.map((a) => [a.job_id, a.job_title])).entries(),
  );

  const shown = applications.filter(
    (a) =>
      (filter === "all" || a.status === filter) && (job === "all" || a.job_id === job),
  );

  function countFor(status: ApplicationStatus) {
    return applications.filter((a) => a.status === status).length;
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Applicants</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Name, email, and one link — everything the widget collects. Shortlist,
            accept, or reject each one.
          </p>
        </div>
        {jobs.length > 1 && (
          <select
            value={job}
            onChange={(e) => setJob(e.target.value)}
            className="input w-auto"
            aria-label="Filter by role"
          >
            <option value="all">All roles</option>
            {jobs.map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex flex-wrap gap-1 text-xs">
        <FilterChip
          label={`All (${applications.length})`}
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        {APPLICATION_STATUSES.map((s) => (
          <FilterChip
            key={s}
            label={`${APPLICATION_STATUS_LABEL[s]} (${countFor(s)})`}
            active={filter === s}
            onClick={() => setFilter(s)}
          />
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="card p-4">
          <p className="text-sm text-[var(--color-muted)]">
            {applications.length === 0
              ? "No applicants yet."
              : "No applicants match those filters."}
          </p>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--color-muted)]">
                <th className="p-3 font-medium">Applicant</th>
                <th className="p-3 font-medium">Role</th>
                <th className="p-3 font-medium">Link</th>
                <th className="p-3 font-medium">Received</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Decision</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((app) => (
                <Row key={app.id} projectId={projectId} app={app} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border border-[var(--color-border)] px-3 py-1 ${
        active ? "bg-[var(--color-bg)] font-semibold" : "text-[var(--color-muted)]"
      }`}
    >
      {label}
    </button>
  );
}

function Row({ projectId, app }: { projectId: string; app: ApplicationRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function change(status: ApplicationStatus) {
    setError(null);
    startTransition(async () => {
      const res = await setApplicationStatus({
        projectId,
        applicationId: app.id,
        status,
      });
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <tr className="border-t border-[var(--color-border)] align-top">
      <td className="p-3">
        <div className="font-medium">{app.full_name}</div>
        <a href={`mailto:${app.email}`} className="text-xs underline text-[var(--color-muted)]">
          {app.email}
        </a>
        {error && <div className="text-xs text-red-600">{error}</div>}
      </td>
      <td className="p-3">{app.job_title}</td>
      <td className="p-3">
        {app.link ? (
          <a
            href={app.link}
            target="_blank"
            rel="noreferrer noopener"
            className="underline break-all"
          >
            {app.link.replace(/^https?:\/\//, "").slice(0, 48)}
          </a>
        ) : (
          <span className="text-[var(--color-muted)]">—</span>
        )}
      </td>
      <td className="p-3 whitespace-nowrap text-[var(--color-muted)]">
        {new Date(app.created_at).toLocaleDateString()}
      </td>
      <td className="p-3">
        <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[app.status]}`}>
          {APPLICATION_STATUS_LABEL[app.status]}
        </span>
      </td>
      <td className="p-3">
        <div className="flex flex-wrap gap-1">
          {app.status !== "shortlisted" && (
            <button
              type="button"
              className="btn btn-secondary text-xs"
              onClick={() => change("shortlisted")}
              disabled={pending}
            >
              Shortlist
            </button>
          )}
          {app.status !== "accepted" && (
            <button
              type="button"
              className="btn btn-secondary text-xs"
              onClick={() => change("accepted")}
              disabled={pending}
            >
              Accept
            </button>
          )}
          {app.status !== "rejected" && (
            <button
              type="button"
              className="btn btn-secondary text-xs"
              onClick={() => change("rejected")}
              disabled={pending}
            >
              Reject
            </button>
          )}
          {app.status !== "new" && (
            <button
              type="button"
              className="btn btn-secondary text-xs text-[var(--color-muted)]"
              onClick={() => change("new")}
              disabled={pending}
              title="Move back to New"
            >
              Undo
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
