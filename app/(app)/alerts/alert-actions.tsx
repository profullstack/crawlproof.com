"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { pauseAlert, resumeAlert, deleteAlert } from "@/app/actions/alerts";

export function AlertActions({ alertId, status }: { alertId: string; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok && res.error) window.alert(res.error);
      router.refresh();
    });
  }

  return (
    <div className="flex shrink-0 gap-2">
      {status === "active" ? (
        <button className="btn" disabled={pending} onClick={() => run(() => pauseAlert(alertId))}>
          Pause
        </button>
      ) : (
        <button className="btn" disabled={pending} onClick={() => run(() => resumeAlert(alertId))}>
          Resume
        </button>
      )}
      <button
        className="btn"
        disabled={pending}
        onClick={() => {
          if (window.confirm("Delete this alert? Its history is removed too.")) {
            run(() => deleteAlert(alertId));
          }
        }}
      >
        Delete
      </button>
    </div>
  );
}
