"use client";

import Link from "next/link";
import { useState } from "react";

type Opportunity = {
  partner_site_id: string;
  partner_domain: string;
  partner_niche: string | null;
  partner_blog_root_url: string | null;
  score: number;
  suggested_topics: string[];
};

type RequestRow = {
  id: string;
  target_site_id: string;
  topic: string;
  status: "queued" | "generating" | "generated" | "failed";
  article_id: string | null;
};

function reqKey(targetSiteId: string, topic: string): string {
  return `${targetSiteId}${topic}`;
}

export function GuestPostOpportunities({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [opps, setOpps] = useState<Opportunity[] | null>(null);
  const [requests, setRequests] = useState<Map<string, RequestRow>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function indexRequests(rows: RequestRow[]): Map<string, RequestRow> {
    const m = new Map<string, RequestRow>();
    for (const r of rows) m.set(reqKey(r.target_site_id, r.topic), r);
    return m;
  }

  async function find() {
    setBusy(true);
    setError(null);
    setNotice(null);
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
        setRequests(indexRequests(json.requests ?? []));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function generate(opp: Opportunity, topic: string) {
    const key = reqKey(opp.partner_site_id, topic);
    setPending(key);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/lx/guest-posts/generate?projectId=${encodeURIComponent(projectId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetSiteId: opp.partner_site_id, topic }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        setError(json?.error ?? "Could not generate guest post.");
      } else if (json.request) {
        setRequests((prev) => {
          const next = new Map(prev);
          next.set(key, {
            id: json.request.id,
            target_site_id: opp.partner_site_id,
            topic,
            status: json.request.status ?? "queued",
            article_id: json.request.article_id ?? null,
          });
          return next;
        });
        setNotice(
          `Guest post queued for ${opp.partner_domain} on "${topic}". Generation takes 1–3 minutes; it will land on the partner blog once delivered.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function unclick(req: RequestRow) {
    const key = reqKey(req.target_site_id, req.topic);
    setPending(key);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/lx/guest-posts/requests/${encodeURIComponent(req.id)}`,
        { method: "DELETE" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        setError(json?.error ?? "Could not remove request.");
      } else {
        setRequests((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
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

      {notice && (
        <p className="text-sm text-[var(--color-pass)]">{notice}</p>
      )}
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
                  <ul className="space-y-1.5 text-sm">
                    {o.suggested_topics.map((t) => {
                      const key = reqKey(o.partner_site_id, t);
                      const req = requests.get(key);
                      const isBusy = pending === key;
                      return (
                        <li
                          key={t}
                          className="flex items-center justify-between gap-2"
                        >
                          <span className="flex-1">{t}</span>
                          <TopicAction
                            req={req}
                            isBusy={isBusy}
                            anyPending={pending !== null}
                            projectId={projectId}
                            onGenerate={() => generate(o, t)}
                            onUnclick={() => req && unclick(req)}
                          />
                        </li>
                      );
                    })}
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

function TopicAction({
  req,
  isBusy,
  anyPending,
  projectId,
  onGenerate,
  onUnclick,
}: {
  req: RequestRow | undefined;
  isBusy: boolean;
  anyPending: boolean;
  projectId: string;
  onGenerate: () => void;
  onUnclick: () => void;
}) {
  if (!req) {
    return (
      <button
        type="button"
        className="btn text-xs"
        disabled={anyPending}
        onClick={onGenerate}
      >
        {isBusy ? "Queuing…" : "Generate this"}
      </button>
    );
  }

  if (req.status === "generated") {
    return (
      <span className="flex items-center gap-2">
        <span className="badge badge-pass text-xs">generated</span>
        {req.article_id && (
          <Link
            href={`/dashboard/projects/${projectId}/autoblog/articles/${req.article_id}`}
            className="btn text-xs"
          >
            View
          </Link>
        )}
      </span>
    );
  }

  if (req.status === "failed") {
    return (
      <span className="flex items-center gap-2">
        <span className="badge badge-fail text-xs">failed</span>
        <button
          type="button"
          className="btn text-xs"
          disabled={anyPending}
          onClick={onGenerate}
          title="Retry this guest-post request"
        >
          {isBusy ? "Retrying…" : "Retry"}
        </button>
        <button
          type="button"
          className="btn text-xs"
          disabled={anyPending}
          onClick={onUnclick}
          title="Cancel this request"
        >
          Remove
        </button>
      </span>
    );
  }

  const statusBadge =
    req.status === "generating" ? (
      <span className="badge badge-warn text-xs">generating</span>
    ) : (
      <span className="badge badge-info text-xs">queued</span>
    );

  return (
    <span className="flex items-center gap-2">
      {statusBadge}
      <button
        type="button"
        className="btn text-xs"
        disabled={anyPending}
        onClick={onUnclick}
        title="Cancel this request"
      >
        {isBusy ? "Removing…" : "Unclick"}
      </button>
    </span>
  );
}
