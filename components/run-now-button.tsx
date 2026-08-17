"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { selectionCost, type Engine } from "@/lib/credits";
import { runScanForProject } from "@/app/actions/runAudit";

// One-click "Run now" — fires a scan using the project's saved engine
// list outside the scheduled cadence. For paid engines we show a confirm
// step so the user can't burn credits with an accidental click.
export function RunNowButton({
  projectId,
  url,
  engines,
}: {
  projectId: string;
  url: string;
  engines: Engine[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const cost = selectionCost(engines);

  function onClick() {
    setError(null);
    if (!confirming && cost > 0) {
      setConfirming(true);
      return;
    }
    start(async () => {
      const res = await runScanForProject({ projectId, url, engines });
      if (!res.ok) {
        setError(res.error);
        setConfirming(false);
        return;
      }
      router.push(`/dashboard/projects/${projectId}/runs/${res.scanRunId}`);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        className="btn btn-primary"
        disabled={pending || engines.length === 0}
        onClick={onClick}
        title="Run a one-off scan now, outside the scheduled cadence"
      >
        {pending
          ? "Starting…"
          : confirming
            ? `Confirm — spend ${cost} credit${cost === 1 ? "" : "s"}`
            : cost === 0
              ? "Run now (free)"
              : `Run now · ${cost} credit${cost === 1 ? "" : "s"}`}
      </button>
      {confirming && !pending && (
        <button className="btn" onClick={() => setConfirming(false)}>
          Cancel
        </button>
      )}
      {error && (
        <span className="text-sm text-[var(--color-fail)]">{error}</span>
      )}
    </div>
  );
}
