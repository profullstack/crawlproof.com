"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startAuditFromForm } from "@/app/actions/runAudit";

export function HeroAuditForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [monthlySales, setMonthlySales] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError("Email is required so we can send you the PDF report.");
      return;
    }
    startTransition(async () => {
      const res = await startAuditFromForm({
        url,
        email,
        phone: phone.trim() || undefined,
        estimatedMonthlySales: monthlySales.trim() || undefined,
        marketingOptIn,
      });
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
        required
        placeholder="Email — we'll send the PDF report here"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="input"
      />
      <input
        type="tel"
        placeholder="Phone (optional)"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        className="input"
        autoComplete="tel"
      />
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        placeholder="Monthly sales from your website (optional, USD)"
        value={monthlySales}
        onChange={(e) => setMonthlySales(e.target.value)}
        className="input"
      />
      <button
        type="submit"
        className="btn btn-primary whitespace-nowrap"
        disabled={pending}
      >
        {pending ? "Starting…" : "Run free audit"}
      </button>
      <label className="flex items-start gap-2 text-xs text-[var(--color-muted)]">
        <input
          type="checkbox"
          checked={marketingOptIn}
          onChange={(e) => setMarketingOptIn(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Also email me occasional CrawlProof updates. Unsubscribe anytime.
        </span>
      </label>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
    </form>
  );
}
