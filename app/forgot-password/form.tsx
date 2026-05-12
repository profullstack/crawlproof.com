"use client";

import { useState, useTransition } from "react";
import { requestPasswordReset } from "@/app/actions/auth";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await requestPasswordReset({ email });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSent(true);
    });
  }

  if (sent) {
    return (
      <p className="mt-6 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-4 text-sm">
        If an account exists for <strong>{email}</strong>, we sent a reset link.
        Check your inbox.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-3">
      <input
        type="email"
        className="input"
        placeholder="you@company.com"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        autoFocus
      />
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
