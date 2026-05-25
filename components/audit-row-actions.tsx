"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { abortAudit, retryAudit } from "@/app/actions/auditOps";

type Props = { projectId: string; auditId: string };

export function AbortAuditButton({ projectId, auditId }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function onClick() {
    if (
      !window.confirm(
        "Cancel this engine? You'll be refunded for its credit cost.",
      )
    )
      return;
    setErr(null);
    start(async () => {
      const r = await abortAudit({ projectId, auditId });
      if (!r.ok) setErr(r.error);
      else router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="text-xs text-[var(--color-muted)] hover:text-[var(--color-fail)] disabled:opacity-50"
        title="Cancel this engine + refund its credit"
      >
        {pending ? "Cancelling…" : "Cancel"}
      </button>
      {err && (
        <span className="text-xs text-[var(--color-fail)]" role="alert">
          {err}
        </span>
      )}
    </>
  );
}

export function RetryAuditButton({ projectId, auditId }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function onClick() {
    setErr(null);
    start(async () => {
      const r = await retryAudit({ projectId, auditId });
      if (!r.ok) setErr(r.error);
      else router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="text-xs text-[var(--color-accent)] hover:underline disabled:opacity-50"
        title="Re-queue this engine"
      >
        {pending ? "Retrying…" : "Retry"}
      </button>
      {err && (
        <span className="text-xs text-[var(--color-fail)]" role="alert">
          {err}
        </span>
      )}
    </>
  );
}
