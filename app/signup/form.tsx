"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignupForm({ redirectTo }: { redirectTo?: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(
          redirectTo ?? "/dashboard",
        )}`,
      },
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    if (data.user && data.session) {
      router.push(redirectTo ?? "/dashboard");
      router.refresh();
    } else {
      setSent(true);
    }
  }

  async function onGoogle() {
    const next = redirectTo ?? "/dashboard";
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
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
      <button type="button" className="btn w-full" onClick={onGoogle}>
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
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
    </div>
  );
}
