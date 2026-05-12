"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const supabase = createClient();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push(redirectTo ?? "/dashboard");
    router.refresh();
  }

  async function onGoogle() {
    const next = redirectTo ?? "/dashboard";
    const callback = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callback },
    });
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
          placeholder="Password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
        <button type="submit" className="btn btn-primary w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
