"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signUpWithPassword, startGoogleOAuth } from "@/app/actions/auth";

export function SignupForm({ redirectTo, defaultEmail }: { redirectTo?: string; defaultEmail?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await signUpWithPassword({ email, password, redirectTo });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.needsConfirmation) {
        setSent(true);
        return;
      }
      router.push(redirectTo ?? "/dashboard");
      router.refresh();
    });
  }

  function onGoogle() {
    setError(null);
    start(async () => {
      const res = await startGoogleOAuth({ redirectTo });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      window.location.href = res.url;
    });
  }

  if (sent) {
    return (
      <p className="mt-6 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-4 text-sm">
        Check your inbox — we sent a confirmation link to <strong>{email}</strong>.
      </p>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      <button type="button" className="btn w-full" onClick={onGoogle} disabled={pending}>
        Continue with Google
      </button>
      <div className="flex items-center gap-3 text-sm text-[var(--color-muted)]">
        <div className="h-px flex-1 bg-[var(--color-border)]" />
        or
        <div className="h-px flex-1 bg-[var(--color-border)]" />
      </div>
      <form onSubmit={onSubmit} className="space-y-3">
        <input
          type="email"
          className="input"
          placeholder="you@company.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        <input
          type="password"
          className="input"
          placeholder="Password (8+ chars)"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
        {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
        <button type="submit" className="btn btn-primary w-full" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </button>
      </form>
    </div>
  );
}
