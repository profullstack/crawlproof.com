"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryFeedItem } from "@/app/actions/socialPosting";

export function RetryFeedItemButton({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  return (
    <span className="mt-1 inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending || done}
        onClick={() => {
          setErr(null);
          start(async () => {
            const r = await retryFeedItem({ itemId });
            if (!r.ok) {
              setErr(r.error);
              return;
            }
            setDone(true);
            router.refresh();
          });
        }}
        className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs hover:bg-[var(--color-card)] disabled:opacity-50"
      >
        {pending ? "Re-queuing…" : done ? "Re-queued" : "Retry"}
      </button>
      {err && <span className="text-xs text-[var(--color-fail)]">{err}</span>}
    </span>
  );
}
