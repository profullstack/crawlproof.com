"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { grantCredits } from "@/app/actions/admin";

export function GrantCreditsForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const n = parseInt(credits, 10);
    if (!Number.isFinite(n)) {
      setError("Credits must be a whole number (positive or negative).");
      return;
    }
    start(async () => {
      const res = await grantCredits({
        email: email.trim(),
        credits: n,
        reason: reason.trim() || undefined,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNotice(
        `${n >= 0 ? "+" : ""}${n} credits applied to ${email.trim()} — new balance ${res.newBalance}.`,
      );
      setCredits("");
      setReason("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Recipient email
        </label>
        <input
          className="input mt-1"
          type="email"
          placeholder="user@example.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr]">
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Credits (± int)
          </label>
          <input
            className="input mt-1 font-mono"
            type="number"
            step="1"
            placeholder="100"
            required
            value={credits}
            onChange={(e) => setCredits(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Reason (optional)
          </label>
          <input
            className="input mt-1"
            type="text"
            maxLength={280}
            placeholder="comp credits / refund / promo / etc."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </div>

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && (
        <p className="text-sm text-[var(--color-pass)]">{notice}</p>
      )}

      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Granting…" : "Grant credits"}
        </button>
      </div>
    </form>
  );
}
