"use client";

import { useState, useTransition } from "react";
import { createWatch } from "@/app/actions/watchScan";

// The recurring lead capture (M2 of docs/lead-engine-prd.md). Sits alongside
// the PDF form at the bottom of /r/<token>.
//
// The report itself stays fully public — gating it would kill the sharing loop
// the OG card exists to create. What costs an email is the ONGOING watch, and
// the ask is self-qualifying: whoever wants a site re-scanned every week is
// the person responsible for that site.
export function WatchForm({
  token,
  host,
  label,
}: {
  token: string;
  host: string;
  label: string;
}) {
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [cadence, setCadence] = useState<"weekly" | "monthly">("weekly");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    startTransition(async () => {
      const res = await createWatch({ token, email: email.trim(), cadence });
      if (!res.ok) {
        setError(res.error ?? "Could not set up that watch.");
        return;
      }
      setDone(true);
    });
  }

  if (done) {
    return (
      <div className="card p-6 text-center">
        <h2 className="text-lg font-bold">Check your inbox</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          We sent a confirmation link to <strong>{email}</strong>. We won&apos;t
          scan {host} again — or send anything else — until you click it.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="card flex flex-col gap-3 p-6">
      <div>
        <h2 className="text-lg font-bold">Watch this URL</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          We&apos;ll re-scan {host} and email you when its {label} actually
          moves — not on a schedule, only when something changes.
        </p>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
          Email
        </span>
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (error) setError(null);
          }}
          className="input w-full"
          autoComplete="email"
        />
      </label>

      <div>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
          Re-scan
        </span>
        <div className="flex gap-2" role="radiogroup" aria-label="Re-scan frequency">
          {(["weekly", "monthly"] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={cadence === c}
              onClick={() => setCadence(c)}
              className="flex-1 rounded-lg border p-2 text-sm font-semibold capitalize transition-colors"
              style={{
                borderColor: cadence === c ? "var(--color-accent)" : "var(--color-border)",
                background:
                  cadence === c
                    ? "color-mix(in oklab, var(--color-accent) 8%, transparent)"
                    : "transparent",
              }}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Sending…" : "Watch this URL"}
      </button>
      <p className="text-xs leading-relaxed text-[var(--color-muted)]">
        Free. We email you to confirm first, and every message has a one-click
        stop link.
      </p>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
    </form>
  );
}
