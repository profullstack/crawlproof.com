"use client";

import { useState } from "react";

export function SecretReveal({
  secret,
  onDismiss,
}: {
  secret: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort
    }
  }

  return (
    <div className="rounded-md border border-yellow-400 bg-yellow-50 p-3 text-sm dark:bg-yellow-950/30">
      <p className="font-semibold">Save this secret now</p>
      <p className="mt-1 text-[var(--color-muted)]">
        We won&apos;t show it again. Use it to verify the{" "}
        <code>webhook-signature</code> header on incoming requests, or as a
        bearer token.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded bg-[var(--color-bg)] px-2 py-1 text-xs">
          {secret}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
        >
          Done
        </button>
      </div>
    </div>
  );
}
