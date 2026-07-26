"use client";

import { useState, useTransition } from "react";
import { submitHireInquiry } from "@/app/actions/hireInquiry";

// defaultEmail / defaultWebsite are prefilled from the query string when the
// visitor arrives from a campaign email, so the form is already half-filled
// with what we know. Every field stays editable.
export function HireForm({
  defaultEmail = "",
  defaultWebsite = "",
}: {
  defaultEmail?: string;
  defaultWebsite?: string;
} = {}) {
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [email, setEmail] = useState(defaultEmail);
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState(defaultWebsite);
  const [monthlyRevenue, setMonthlyRevenue] = useState("");
  const [location, setLocation] = useState("");
  const [message, setMessage] = useState("");
  const [company, setCompany] = useState(""); // honeypot
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div className="card p-6">
        <h2 className="text-lg font-semibold">Got it — talk soon.</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          We&apos;ll reach out within a few hours during business hours.
          If it&apos;s urgent, email us directly at{" "}
          <a className="underline" href="mailto:hello@crawlproof.com">
            hello@crawlproof.com
          </a>
          .
        </p>
      </div>
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await submitHireInquiry({
        name,
        email,
        phone,
        website,
        monthlyRevenue: monthlyRevenue || undefined,
        location: location || undefined,
        message: message || undefined,
        company,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone(true);
    });
  }

  return (
    <form onSubmit={submit} className="card flex flex-col gap-3 p-5">
      {/* Honeypot — visually hidden, off-screen, ignored by real users. */}
      <input
        type="text"
        name="company"
        tabIndex={-1}
        autoComplete="off"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "-10000px",
          width: 1,
          height: 1,
          opacity: 0,
        }}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Name
          </span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
            autoComplete="name"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Email
          </span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
            autoComplete="email"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Phone
          </span>
          <input
            type="tel"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="input"
            autoComplete="tel"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Website
          </span>
          <input
            type="url"
            required
            placeholder="https://your-site.com"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            className="input"
            autoComplete="url"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Monthly revenue (optional)
          </span>
          <input
            value={monthlyRevenue}
            onChange={(e) => setMonthlyRevenue(e.target.value)}
            placeholder="e.g. $25k / mo"
            className="input"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Location (optional)
          </span>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="City, country"
            className="input"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Anything else? (optional)
        </span>
        <textarea
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="input"
          placeholder="What's broken, what you've tried, deadline, etc."
        />
      </label>

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending…" : "Request a fix"}
      </button>
      <p className="text-xs text-[var(--color-muted)]">
        We typically respond within a few hours with a scope and a quote. The
        work itself usually runs two to three weeks.
      </p>
    </form>
  );
}
