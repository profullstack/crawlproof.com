"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { abortScanRun } from "@/app/actions/abortScanRun";

// Cancel every queued / running audit in this scan run. Confirms before
// firing because the action also refunds credits and the user shouldn't
// be able to spam it accidentally.
export function AbortScanButton({
  projectId,
  runId,
}: {
  projectId: string;
  runId: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    if (!confirming) {
      setConfirming(true);
      return;
    }
    start(async () => {
      const res = await abortScanRun({ projectId, runId });
      setConfirming(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        className="btn"
        onClick={onClick}
        disabled={pending}
        title="Cancel queued / running engines in this scan and refund credits"
      >
        {pending
          ? "Aborting…"
          : confirming
            ? "Confirm abort + refund"
            : "Abort scan"}
      </button>
      {confirming && !pending && (
        <button className="btn" onClick={() => setConfirming(false)}>
          Keep running
        </button>
      )}
      {error && (
        <span className="text-sm text-[var(--color-fail)]">{error}</span>
      )}
    </div>
  );
}
