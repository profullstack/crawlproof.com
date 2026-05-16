"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startAuditFromForm } from "@/app/actions/runAudit";

// Datafa.st injects `window.datafast` once its script.js loads. Calls
// before then are dropped silently — that's the right behavior here:
// we don't want analytics to ever block or break a real conversion.
declare global {
  interface Window {
    datafast?: (
      eventName: string,
      customData?: Record<string, string>,
      callback?: (r: { status: number }) => void,
    ) => void;
  }
}

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
    // Fire as soon as the user commits to submit (before the action).
    // This is the denominator for the conversion funnel — pageview →
    // attempt → success.
    window.datafast?.("audit_submit_attempted", {
      has_phone: phone.trim() ? "yes" : "no",
      has_sales: monthlySales.trim() ? "yes" : "no",
      marketing_opt_in: marketingOptIn ? "yes" : "no",
    });
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
        // Slugify the error message so we don't blow past Datafa.st's
        // 255-char value limit + keep distinct error buckets tidy.
        const reason = (res.error ?? "unknown")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 64);
        window.datafast?.("audit_submit_failed", { reason });
        return;
      }
      window.datafast?.("audit_submitted", {
        marketing_opt_in: marketingOptIn ? "yes" : "no",
      });
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
