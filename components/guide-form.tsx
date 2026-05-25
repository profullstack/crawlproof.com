"use client";

import { useState, useTransition } from "react";
import { requestPremiumGuide } from "@/app/actions/premiumGuide";

const roles = [
  "Founder / Exec",
  "Marketing Leader",
  "SEO / Growth",
  "Developer / Platform",
  "Agency",
  "Other",
];

const teamSizes = ["Just me", "2-10", "11-50", "51-200", "201-1,000", "1,000+"];

export function GuideForm() {
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [website, setWebsite] = useState(""); // honeypot
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await requestPremiumGuide({
        name,
        email,
        company: company || undefined,
        role: role || undefined,
        teamSize: teamSize || undefined,
        marketingOptIn,
        website,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone(true);
      const a = document.createElement("a");
      a.href = res.downloadUrl;
      a.download = "CrawlProof_Premium_Deck.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  return (
    <form onSubmit={submit} className="card flex flex-col gap-4 p-5">
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "-10000px",
          width: 1,
          height: 1,
          opacity: 0,
        }}
      />

      <div>
        <h2 className="text-xl font-bold">Get guide</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          We&apos;ll email you the PDF and start the download right away.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Name *
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
          Work email *
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
          Company
        </span>
        <input
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="input"
          autoComplete="organization"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Role
          </span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="input"
          >
            <option value="">Optional</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Team size
          </span>
          <select
            value={teamSize}
            onChange={(e) => setTeamSize(e.target.value)}
            className="input"
          >
            <option value="">Optional</option>
            {teamSizes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex gap-3 text-sm text-[var(--color-muted)]">
        <input
          type="checkbox"
          checked={marketingOptIn}
          onChange={(e) => setMarketingOptIn(e.target.checked)}
          className="mt-1 h-4 w-4"
        />
        <span>
          Send me occasional CrawlProof updates. Unsubscribe anytime.
        </span>
      </label>

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {done && (
        <p className="text-sm text-[var(--color-pass)]">
          Sent. Your download should start automatically.
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending..." : "Download the guide"}
      </button>
      <p className="text-xs text-[var(--color-muted)]">
        No payment. No sales call. Direct PDF link in your inbox.
      </p>
    </form>
  );
}
