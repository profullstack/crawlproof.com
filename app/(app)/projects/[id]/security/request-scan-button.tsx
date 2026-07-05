"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestPortScan } from "@/app/actions/portScans";

export function RequestScanButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run() {
    startTransition(async () => {
      setError(null);
      const res = await requestPortScan(projectId);
      if (!res.ok) {
        setError(res.error ?? "Failed to queue scan.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        onClick={run}
        disabled={pending}
        className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
      >
        {pending ? "Queuing…" : "Run scan"}
      </button>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
