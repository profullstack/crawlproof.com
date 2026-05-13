"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Tiny live refresher: polls the status endpoint and triggers a
// server-side re-render via router.refresh() when something changes.
// Used on the owner-only scan-run page to keep the engine cards fresh
// while audits are still queued/running. Stops polling once everything
// reaches a terminal state.
export function ScanRunRefresh({
  projectId,
  runId,
  done,
}: {
  projectId: string;
  runId: string;
  done: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    if (done) return;
    let cancelled = false;
    let lastSignature: string | null = null;

    const tick = async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/runs/${runId}/status`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          audits?: Array<{ id: string; status: string; score: number | null }>;
        };
        if (cancelled || !data.audits) return;
        const sig = data.audits
          .map((a) => `${a.id}:${a.status}:${a.score ?? "_"}`)
          .sort()
          .join("|");
        if (lastSignature !== null && sig !== lastSignature) {
          router.refresh();
        }
        lastSignature = sig;
        const allDone = data.audits.every(
          (a) => a.status === "complete" || a.status === "failed",
        );
        if (allDone) {
          router.refresh();
          cancelled = true;
        }
      } catch {
        /* keep polling */
      }
    };
    const id = setInterval(tick, 4000);
    tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectId, runId, done, router]);

  return null;
}
