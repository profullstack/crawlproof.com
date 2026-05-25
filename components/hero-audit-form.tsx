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
  const [listPublic, setListPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setUrlError(null);
    setEmailError(null);
    if (!url.trim()) {
      setUrlError("Website URL is required.");
      return;
    }
    if (email.trim() && !email.includes("@")) {
      setEmailError("Enter a valid email address.");
      return;
    }
    if (marketingOptIn && !email.trim()) {
      setEmailError("Enter an email address to receive updates.");
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
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        estimatedMonthlySales: monthlySales.trim() || undefined,
        marketingOptIn,
        listPublic,
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
        listed_public: listPublic ? "yes" : "no",
      });
      router.push(`/r/${res.token}`);
    });
  }

  return (
    <form onSubmit={submit} noValidate className="card flex flex-col gap-3 p-4 text-left">
      <Field label="Website URL" error={urlError}>
        <input
          type="url"
          inputMode="url"
          placeholder="https://your-site.com"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (urlError) setUrlError(null);
          }}
          className="input"
          autoFocus
          aria-invalid={!!urlError}
        />
      </Field>
      <Field
        label="Email"
        helper="Optional. Add it if you want the PDF emailed to you; the report opens on-page either way."
        error={emailError}
      >
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (emailError) setEmailError(null);
          }}
          className="input"
          aria-invalid={!!emailError}
        />
      </Field>
      <Field label="Phone" helper="Optional.">
        <input
          type="tel"
          placeholder="+1 555 123 4567"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="input"
          autoComplete="tel"
        />
      </Field>
      <Field
        label="Monthly website sales"
        helper="Optional. Used only to estimate the possible revenue impact of crawlability issues."
      >
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          placeholder="USD"
          value={monthlySales}
          onChange={(e) => setMonthlySales(e.target.value)}
          className="input"
        />
      </Field>
      <button
        type="submit"
        className="btn btn-primary whitespace-nowrap"
        disabled={pending}
      >
        {pending ? "Starting..." : "Run free audit"}
      </button>
      <div className="border-t border-[var(--color-border)] pt-3">
        <label className="flex items-start gap-2 text-xs text-[var(--color-muted)]">
          <input
            type="checkbox"
            checked={listPublic}
            onChange={(e) => setListPublic(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Optional: list this free scan on Recent scans. Unchecked scans are
            unlisted but still viewable by anyone with the report link.
          </span>
        </label>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-muted)]">
          Common tracking parameters are removed before the URL is saved.
          Create a private project after signup for private scan history.
        </p>
      </div>
      <div className="border-t border-[var(--color-border)] pt-3">
        <label className="flex items-start gap-2 text-xs text-[var(--color-muted)]">
          <input
            type="checkbox"
            checked={marketingOptIn}
            onChange={(e) => setMarketingOptIn(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Optional: email me occasional CrawlProof updates. Unsubscribe anytime.
          </span>
        </label>
      </div>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
    </form>
  );
}

function Field({
  label,
  helper,
  error,
  children,
}: {
  label: string;
  helper?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </span>
      {children}
      {helper && !error && (
        <span className="mt-1 block text-xs leading-relaxed text-[var(--color-muted)]">
          {helper}
        </span>
      )}
      {error && (
        <span className="mt-1 block text-xs leading-relaxed text-[var(--color-fail)]">
          {error}
        </span>
      )}
    </label>
  );
}
