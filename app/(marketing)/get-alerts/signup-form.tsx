"use client";

import { useMemo, useState, useTransition } from "react";
import { ALERT_CATEGORIES } from "@/lib/alerts/categories";
import { requestAlertSignup } from "@/app/actions/alerts";

const PICKABLE = ALERT_CATEGORIES.filter((c) => !c.gated && c.key !== "custom");

export function SignupForm() {
  const [pending, startTransition] = useTransition();
  const [categoryKey, setCategoryKey] = useState(PICKABLE[0].key);
  const [term, setTerm] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const category = useMemo(() => PICKABLE.find((c) => c.key === categoryKey)!, [categoryKey]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!term.trim()) return setError(`${category.inputLabel} is required.`);
    if (!email.trim()) return setError("Email is required.");
    startTransition(async () => {
      const res = await requestAlertSignup({ email, category: categoryKey, term });
      if (!res.ok) return setError(res.error);
      setSent(true);
    });
  }

  if (sent) {
    return (
      <div className="card text-center">
        <div className="text-lg font-semibold">Check your inbox ✉️</div>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          We sent a confirmation link to <span className="text-[var(--color-fg)]">{email}</span>. Click it and your
          alert goes live — no password, no card.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium">I want to track…</label>
        <div className="flex flex-wrap gap-2">
          {PICKABLE.map((c) => (
            <button
              type="button"
              key={c.key}
              onClick={() => setCategoryKey(c.key)}
              className={`badge ${c.key === categoryKey ? "badge-pass" : ""}`}
            >
              {c.title}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-[var(--color-muted)]">{category.template}</p>
      </div>
      <input
        className="input"
        placeholder={category.inputPlaceholder}
        aria-label={category.inputLabel}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />
      <input
        className="input"
        type="email"
        placeholder="you@company.com"
        aria-label="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Sending…" : "Get free alerts"}
      </button>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      <p className="text-center text-xs text-[var(--color-muted)]">
        Free forever for up to 50 alerts. One-click unsubscribe in every email.
      </p>
    </form>
  );
}
