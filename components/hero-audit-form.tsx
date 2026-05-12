"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startAuditFromForm } from "@/app/actions/runAudit";

export function HeroAuditForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await startAuditFromForm({ url, email: email || undefined });
      if (!res.ok) {
        setError(res.error ?? "Could not start audit.");
        return;
      }
      router.push(`/r/${res.token}`);
    });
  }

  return (
    <form onSubmit={submit} className="card flex flex-col gap-2 p-3">
      <input
        type="url"
        required
        placeholder="https://your-site.com"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="input"
        autoFocus
      />
      <input
        type="email"
        placeholder="Email (optional, for PDF report)"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="input"
      />
      <button
        type="submit"
        className="btn btn-primary whitespace-nowrap"
        disabled={pending}
      >
        {pending ? "Starting…" : "Run free audit"}
      </button>
      {email && (
        <p className="text-xs text-[var(--color-muted)]">
          We&apos;ll email the PDF report to <strong>{email}</strong> when ready.
        </p>
      )}
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
    </form>
  );
}
