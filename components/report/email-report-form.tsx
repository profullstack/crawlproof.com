"use client";

import { useState, useTransition } from "react";
import { requestReportPdf } from "@/app/actions/reportPdf";

// Post-report PDF capture. Shown at the BOTTOM of /r/<token>, after the
// findings — value-first, so we ask for an email only once the visitor has
// already seen the report. Email is required (it's where the PDF goes);
// phone and monthly sales stay optional.
export function EmailReportForm({
  token,
  complete,
}: {
  token: string;
  complete: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [monthlySales, setMonthlySales] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | "emailed" | "queued">(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    startTransition(async () => {
      const res = await requestReportPdf({
        token,
        email: email.trim(),
        phone: phone.trim() || undefined,
        estimatedMonthlySales: monthlySales.trim() || undefined,
        marketingOptIn,
      });
      if (!res.ok) {
        setError(res.error ?? "Could not send the PDF.");
        return;
      }
      setDone(res.emailed ? "emailed" : "queued");
    });
  }

  if (done) {
    return (
      <div className="card p-6 text-center">
        <h2 className="text-lg font-bold">
          {done === "emailed" ? "PDF on its way" : "We've got it"}
        </h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {done === "emailed"
            ? `We emailed the PDF report to ${email}. Check your inbox (and spam, just in case).`
            : `As soon as this scan finishes, we'll email the PDF report to ${email}.`}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="card flex flex-col gap-3 p-6">
      <div>
        <h2 className="text-lg font-bold">Email yourself this report</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {complete
            ? "Get a PDF copy of this audit in your inbox — handy for sharing with a client, dev, or teammate."
            : "Drop your email and we'll send the PDF the moment this scan finishes."}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email">
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(null);
            }}
            className="input"
            autoComplete="email"
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
      </div>
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
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending…" : "Email me the PDF"}
      </button>
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
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
    </form>
  );
}

function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </span>
      {children}
      {helper && (
        <span className="mt-1 block text-xs leading-relaxed text-[var(--color-muted)]">
          {helper}
        </span>
      )}
    </label>
  );
}
