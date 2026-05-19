"use client";

import { useState } from "react";

type Opportunity = {
  partner_site_id: string;
  partner_domain: string;
  partner_niche: string | null;
  partner_blog_root_url: string | null;
  score: number;
  suggested_topics: string[];
};

export function GuestPostOpportunities({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [opps, setOpps] = useState<Opportunity[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/lx/guest-posts/opportunities?projectId=${encodeURIComponent(projectId)}`,
        { method: "POST" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        setError(json?.error ?? "Could not find opportunities.");
      } else {
        setOpps(json.opportunities ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Guest post opportunities</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Find partner blogs in the network where a guest post would fit.
            We cross your seeds with theirs to suggest bridge topics.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={find}
        >
          {busy ? "Searching…" : "Find guest post opportunities"}
        </button>
      </div>

      {error && (
        <p className="text-sm text-[var(--color-fail)]">{error}</p>
      )}

      {opps !== null && opps.length === 0 && !busy && (
        <p className="text-sm text-[var(--color-muted)]">
          No matching partners right now. The network is still small — try
          again later, or add a seed keyword that bridges to another niche.
        </p>
      )}

      {opps && opps.length > 0 && (
        <ul className="space-y-3">
          {opps.map((o) => (
            <li
              key={o.partner_site_id}
              className="rounded-md border border-[var(--color-border)] p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <a
                    href={o.partner_blog_root_url ?? `https://${o.partner_domain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {o.partner_domain}
                  </a>
                  {o.partner_niche && (
                    <span className="ml-2 text-sm text-[var(--color-muted)]">
                      {o.partner_niche}
                    </span>
                  )}
                </div>
                <span className="badge badge-info">
                  match score {o.score}
                </span>
              </div>
              {o.suggested_topics.length > 0 ? (
                <div className="mt-2 space-y-1">
                  <p className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
                    Suggested topics
                  </p>
                  <ul className="ml-4 list-disc space-y-0.5 text-sm">
                    {o.suggested_topics.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mt-2 text-xs text-[var(--color-muted)]">
                  No topic crosses available — set seed keywords + modifiers
                  on both sides to unlock suggestions.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
