"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signInWithPassword, startGoogleOAuth } from "@/app/actions/auth";

const googleEnabled = process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === "true";

export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await signInWithPassword({ email, password });
      if (!res.ok) {
        setError(res.error);
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

  return (
    <div className="mt-6 space-y-4">
      {googleEnabled && (
        <>
          <button type="button" className="btn w-full" onClick={onGoogle} disabled={pending}>
            Continue with Google
          </button>
          <div className="flex items-center gap-3 text-sm text-[var(--color-muted)]">
            <div className="h-px flex-1 bg-[var(--color-border)]" />
            or
            <div className="h-px flex-1 bg-[var(--color-border)]" />
          </div>
        </>
      )}
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
          placeholder="Password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
        <button type="submit" className="btn btn-primary w-full" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
        <div className="pt-1 text-right">
          <Link
            href="/forgot-password"
            className="text-xs text-[var(--color-muted)] underline"
          >
            Forgot password?
          </Link>
        </div>
      </form>
    </div>
  );
}
