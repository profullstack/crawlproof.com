"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { refreshLeadsAction } from "@/app/actions/leads";

/**
 * "Check scans" — pulls finished scans into the leads that are waiting on
 * them and looks for a contact address.
 *
 * Discovery queues a scan and returns immediately, so a fresh lead has no
 * findings and no contact yet. This is what closes that loop for leads added
 * by hand; a campaign does it on its own tick.
 */
export function RefreshLeads({ projectId, pendingCount }: { projectId: string; pendingCount: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () =>
    start(async () => {
      setNote(null);
      setError(null);
      const res = await refreshLeadsAction({ projectId });
      if (res.ok) {
        setNote(res.note);
        router.refresh();
      } else setError(res.error);
    });

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {note && <span className="text-xs text-[var(--color-muted)]">{note}</span>}
      {error && <span className="text-xs text-[var(--color-danger,#f87171)]">{error}</span>}
      <button onClick={run} disabled={pending || pendingCount === 0} className="btn text-sm">
        {pending
          ? "Checking…"
          : pendingCount > 0
            ? `Check scans (${pendingCount})`
            : "All researched"}
      </button>
    </div>
  );
}
