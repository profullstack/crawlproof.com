"use client";

import { useState, useTransition } from "react";
import { requestReportPdf } from "@/app/actions/reportPdf";

// Post-report PDF capture. Shown at the BOTTOM of /r/<token>, after the
// findings — value-first, so we ask for an email only once the visitor has
// already seen the report. Email is the only thing asked for up front; the
// commercial questions (monthly sales, phone) appear only behind an explicit
// "estimate what this costs me" action, and remain optional even then.
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
  // Revealed only when the visitor asks for the impact estimate — see the
  // note on the form body.
  const [wantsEstimate, setWantsEstimate] = useState(false);
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
      {/* Email alone, and nothing else, until the visitor asks for more.

          The form previously showed three inputs for what is a one-field
          request: a phone number and "monthly website sales" sat next to the
          email, both marked optional. Optional or not, being asked your
          revenue in order to receive a PDF reads as a sales qualification,
          and it is the wrong trade at the moment somebody is doing us the
          favour of handing over an address. The commercial questions are
          worth asking — but behind something the visitor chose, for a thing
          they get in return. */}
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

      {!wantsEstimate ? (
        <button
          type="button"
          onClick={() => setWantsEstimate(true)}
          className="self-start text-sm underline text-[var(--color-muted)]"
        >
          Also estimate what these issues might cost me
        </button>
      ) : (
        <div className="flex flex-col gap-3 border-l-2 border-[var(--color-border)] pl-3">
          <p className="text-xs leading-relaxed text-[var(--color-muted)]">
            We&apos;ll add a revenue-impact estimate to the report. Both fields are
            optional — the PDF sends either way.
          </p>
          <Field label="Monthly website sales">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder="USD"
              value={monthlySales}
              onChange={(e) => setMonthlySales(e.target.value)}
              className="input"
              autoFocus
            />
          </Field>
          <Field label="Phone" helper="Only if you'd like us to walk through it.">
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
      )}

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
