"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updatePassword } from "@/app/actions/auth";

export function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    start(async () => {
      const res = await updatePassword({ password });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-3">
      <input
        type="password"
        className="input"
        placeholder="New password (8+ chars)"
        required
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        autoFocus
      />
      <input
        type="password"
        className="input"
        placeholder="Confirm new password"
        required
        minLength={8}
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
      />
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
