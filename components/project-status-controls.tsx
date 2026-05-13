"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  archiveProject,
  pauseProject,
  restoreProject,
  resumeProject,
  type ProjectStatus,
} from "@/app/actions/projects";

export function ProjectStatusControls({
  projectId,
  status,
}: {
  projectId: string;
  status: ProjectStatus;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function call(fn: (id: string) => Promise<unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    start(async () => {
      await fn(projectId);
      router.refresh();
    });
  }

  if (status === "archived") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-unknown">Archived</span>
        <button
          className="btn"
          disabled={pending}
          onClick={() => call(restoreProject)}
        >
          Restore
        </button>
      </div>
    );
  }

  const isPaused = status === "paused";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`badge ${isPaused ? "badge-warn" : "badge-pass"}`}>
        {isPaused ? "Paused" : "Active"}
      </span>
      <button
        className="btn"
        disabled={pending}
        onClick={() => call(isPaused ? resumeProject : pauseProject)}
      >
        {isPaused ? "Resume" : "Pause"}
      </button>
      <button
        className="btn"
        disabled={pending}
        onClick={() =>
          call(
            archiveProject,
            "Archive this project? It will stop scheduled scans and be hidden from the dashboard. You can restore it later.",
          )
        }
      >
        Archive
      </button>
    </div>
  );
}
