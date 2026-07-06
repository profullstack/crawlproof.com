"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setMonitorEnabled, deleteMonitor } from "@/app/actions/monitors";

export function MonitorActions({
  projectId,
  monitorId,
  enabled,
  name,
}: {
  projectId: string;
  monitorId: string;
  enabled: boolean;
  name: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function toggle() {
    start(async () => {
      await setMonitorEnabled(projectId, monitorId, !enabled);
      router.refresh();
    });
  }
  function remove() {
    if (!window.confirm(`Delete monitor "${name}"?`)) return;
    start(async () => {
      await deleteMonitor(projectId, monitorId);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        onClick={toggle}
        disabled={pending}
        className="text-[var(--color-muted)] hover:underline disabled:opacity-60"
      >
        {enabled ? "Pause" : "Resume"}
      </button>
      <button
        onClick={remove}
        disabled={pending}
        className="text-[var(--color-fail)] hover:underline disabled:opacity-60"
      >
        Delete
      </button>
    </div>
  );
}
