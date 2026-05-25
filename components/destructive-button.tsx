"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Two-click destructive action: first click reveals a confirmation
// state with the original label replaced by "Click again to confirm".
// Avoids accidental destruction without needing a modal.

export function DestructiveButton({
  label,
  confirmLabel = "Click again to confirm",
  pendingLabel,
  onConfirm,
  redirectTo,
}: {
  label: string;
  confirmLabel?: string;
  pendingLabel?: string;
  onConfirm: () => Promise<{ ok: true } | { ok: false; error: string }>;
  // Optional redirect after success (e.g. /dashboard after deleting
  // a project). If omitted we just router.refresh().
  redirectTo?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setArmed(false);
  }

  function onClick() {
    if (!armed) {
      setError(null);
      setArmed(true);
      // Auto-disarm after a few seconds so the page doesn't stay
      // in a one-misclick-from-destruction state forever.
      setTimeout(reset, 5_000);
      return;
    }
    start(async () => {
      const res = await onConfirm();
      if (!res.ok) {
        setError(res.error);
        setArmed(false);
        return;
      }
      if (redirectTo) {
        router.push(redirectTo);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className={
          "btn text-xs " +
          (armed
            ? "border-[var(--color-fail)] bg-[var(--color-fail)]/15 text-[var(--color-fail)]"
            : "text-[var(--color-muted)] hover:text-[var(--color-fail)]")
        }
      >
        {pending
          ? (pendingLabel ?? "Deleting…")
          : armed
            ? confirmLabel
            : label}
      </button>
      {error && <span className="text-xs text-[var(--color-fail)]">{error}</span>}
    </div>
  );
}
