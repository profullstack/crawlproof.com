"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function LivePoller({ id }: { id: string }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/audits/${id}`, { cache: "no-store" });
        const data = await res.json();
        if (data?.audit?.status === "complete" || data?.audit?.status === "failed") {
          router.refresh();
        }
      } catch {
        /* ignore */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [id, router]);
  return (
    <div className="card flex items-center gap-3 p-5">
      <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
      <div>
        <div className="font-semibold">Running your audit…</div>
        <p className="text-sm text-[var(--color-muted)]">
          Fetching pages, rendering, checking schema and robots. Usually under 90 seconds.
        </p>
      </div>
    </div>
  );
}
