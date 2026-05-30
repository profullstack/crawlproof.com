"use client";

import { useState, useTransition } from "react";
import { getBlueskyAppPassword } from "@/app/actions/socialPosting";

export function AppPasswordReveal({ accountId }: { accountId: string }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function toggle() {
    setErr(null);
    if (value) {
      setValue(null);
      return;
    }
    start(async () => {
      const r = await getBlueskyAppPassword({ accountId });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      setValue(r.appPassword);
    });
  }

  function copy() {
    setErr(null);
    start(async () => {
      let v = value;
      if (!v) {
        const r = await getBlueskyAppPassword({ accountId });
        if (!r.ok) {
          setErr(r.error);
          return;
        }
        v = r.appPassword;
        setValue(v);
      }
      try {
        await navigator.clipboard.writeText(v);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // clipboard unavailable
      }
    });
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-[var(--color-muted)]">App password:</span>
      <code className="rounded bg-[var(--color-card)] px-1.5 py-0.5 font-mono">
        {value ?? "••••••••••••"}
      </code>
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        className="text-[var(--color-accent)] hover:underline disabled:opacity-50"
      >
        {pending ? "…" : value ? "Hide" : "Show"}
      </button>
      <button
        type="button"
        onClick={copy}
        disabled={pending}
        className="text-[var(--color-accent)] hover:underline disabled:opacity-50"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
      {err && <span className="text-[var(--color-fail)]">{err}</span>}
    </div>
  );
}
