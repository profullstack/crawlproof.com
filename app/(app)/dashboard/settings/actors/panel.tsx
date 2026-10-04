"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { Actor } from "@/lib/tracker/actorStore";

type Site = { id: string; name: string; url: string };

/** The site's address with ?crp_actor=<token>, which stats.js stores and strips. */
function declareLink(siteUrl: string, token: string) {
  try {
    const u = new URL(siteUrl);
    u.searchParams.set("crp_actor", token);
    return u.toString();
  } catch {
    return null;
  }
}

/** For any other tracked site: one click stores the token for that site. */
function bookmarklet(token: string) {
  return `javascript:(function(){if(typeof window.crawlproof==='function'){window.crawlproof('actor','${token}');alert('CrawlProof: this browser is declared on '+location.hostname)}else{alert('No CrawlProof tracker on this page')}})()`;
}

/**
 * React 19 refuses a javascript: URL in href, so the bookmarklet's address is
 * set on the element directly once it is mounted.
 */
function BookmarkletLink({ token }: { token: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    ref.current?.setAttribute("href", bookmarklet(token));
  }, [token]);
  return (
    <a ref={ref} className="btn btn-secondary text-sm" onClick={(e) => e.preventDefault()}>
      Declare me here
    </a>
  );
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? res.status));
  return json;
}

function ago(iso: string | null) {
  return iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "never";
}

export function ActorsPanel({ initial, sites }: { initial: Actor[]; sites: Site[] }) {
  const [actors, setActors] = useState(initial);
  const [browser, setBrowser] = useState<{ token: string; who: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"human" | "agent">("human");
  const [operator, setOperator] = useState("");

  const refresh = useCallback(async () => {
    const list = await call("GET", "/api/tracker/v1/actors");
    setActors((list.actors as Actor[]) ?? []);
  }, []);

  const run = (fn: () => Promise<string | void>) => {
    setError(null);
    setNotice(null);
    start(async () => {
      try {
        const msg = await fn();
        await refresh();
        if (msg) setNotice(msg);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

  const humans = actors.filter((a) => a.kind === "human");

  return (
    <div className="space-y-6">
      {browser && (
        <div className="card space-y-3 border-[var(--color-pass)] p-5">
          <h2 className="text-lg font-semibold">Declare this browser as {browser.who}</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Open each site once in this browser. The tracker stores the token for that site and
            removes it from the address bar; every later visit is declared. The tracker stays
            cookieless, so this is per site and per browser.
          </p>
          {sites.length > 0 ? (
            <ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
              {sites.map((site) => {
                const href = declareLink(site.url, browser.token);
                return href ? (
                  <li key={site.id}>
                    <a className="underline" href={href} target="_blank" rel="noopener">
                      {site.name || site.url}
                    </a>
                  </li>
                ) : null;
              })}
            </ul>
          ) : (
            <p className="text-sm">None of your projects has the tracker on yet.</p>
          )}
          <p className="text-sm">
            Any other site with the tracker: drag this to your bookmarks bar and click it there:{" "}
            <BookmarkletLink token={browser.token} />
          </p>
          <button className="btn btn-secondary text-sm" onClick={() => setBrowser(null)}>
            Done
          </button>
        </div>
      )}

      {freshToken && (
        <div className="card space-y-2 border-[var(--color-pass)] p-5">
          <h2 className="text-sm font-semibold">New token: copy it now, it is not shown again</h2>
          <code className="block break-all text-sm">{freshToken}</code>
          <p className="text-xs text-[var(--color-muted)]">
            Send it as the <code>Crawlproof-Actor</code> header (headless agents), open any tracked
            site with <code>?crp_actor=&lt;token&gt;</code>, or call{" "}
            <code>crawlproof(&apos;actor&apos;, &apos;&lt;token&gt;&apos;)</code>.
          </p>
          <button className="btn btn-secondary text-sm" onClick={() => setFreshToken(null)}>
            Done
          </button>
        </div>
      )}

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}

      <div className="card divide-y divide-[var(--color-border)]">
        {actors.length === 0 && (
          <p className="p-5 text-sm text-[var(--color-muted)]">No actors yet. Add yourself first.</p>
        )}
        {actors.map((a) => {
          const op = a.operator_actor_id ? actors.find((x) => x.id === a.operator_actor_id) : null;
          return (
            <div key={a.id} className="space-y-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {a.name || a.email}{" "}
                    <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-xs">{a.kind}</span>
                  </p>
                  <p className="text-xs text-[var(--color-muted)]">
                    {a.email} · {a.email_verified ? "verified" : "unverified"} · {a.visibility}
                    {op ? ` · operated by ${op.name || op.email}` : ""}
                  </p>
                  <p className="text-xs text-[var(--color-muted)]">
                    Last 30 days: {a.last30.pageviews} pageviews, {a.last30.events} events on{" "}
                    {a.last30.sites} site{a.last30.sites === 1 ? "" : "s"}
                    {a.last30.contradictions ? (
                      <span className="text-[var(--color-fail)]">
                        {" "}· {a.last30.contradictions} contradicted by bot detection
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn btn-primary text-sm"
                    disabled={pending}
                    onClick={() => run(async () => {
                      const r = await call("POST", `/api/tracker/v1/actors/${a.id}/tokens`, { label: "browser" });
                      setBrowser({ token: String(r.token), who: a.name || a.email });
                    })}
                  >
                    Declare this browser
                  </button>
                  <button
                    className="btn btn-secondary text-sm"
                    disabled={pending}
                    onClick={() => run(async () => {
                      const r = await call("POST", `/api/tracker/v1/actors/${a.id}/tokens`, { label: "dashboard" });
                      setFreshToken(String(r.token));
                    })}
                  >
                    New token
                  </button>
                  <button
                    className="btn btn-secondary text-sm"
                    disabled={pending}
                    onClick={() => run(async () => {
                      await call("PATCH", `/api/tracker/v1/actors/${a.id}`, { visibility: a.visibility === "public" ? "private" : "public" });
                    })}
                  >
                    Make {a.visibility === "public" ? "private" : "public"}
                  </button>
                  <button
                    className="btn btn-secondary text-sm"
                    disabled={pending}
                    onClick={() => {
                      if (!confirm(`Revoke ${a.email} and every token it has?`)) return;
                      run(async () => { await call("DELETE", `/api/tracker/v1/actors/${a.id}`); return `Revoked ${a.email}.`; });
                    }}
                  >
                    Revoke
                  </button>
                </div>
              </div>
              {a.tokens.length > 0 && (
                <ul className="space-y-1 text-xs">
                  {a.tokens.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center gap-2">
                      <code>{t.prefix}…</code>
                      <span>{t.label || "(no label)"}</span>
                      <span className="text-[var(--color-muted)]">last used {ago(t.last_used_at)}</span>
                      <button
                        className="underline"
                        disabled={pending}
                        onClick={() => run(async () => { await call("DELETE", `/api/tracker/v1/actors/${a.id}/tokens?token=${t.id}`); return "Token revoked."; })}
                      >
                        revoke
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <form
        className="card space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const r = await call("POST", "/api/tracker/v1/actors", {
              email,
              name,
              kind,
              operator: kind === "agent" && operator ? operator : undefined,
            });
            setEmail("");
            setName("");
            setOperator("");
            const v = String(r.verification);
            return v === "owner-login"
              ? "Added and verified (it is your login address)."
              : v === "sent"
                ? "Added. A verification email is on its way; until it is clicked the address shows as unverified."
                : `Added, unverified: the verification email could not be sent (${String(r.verificationError ?? "unknown")}).`;
          });
        }}
      >
        <h2 className="text-lg font-semibold">Add an actor</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            Email
            <input className="input mt-1" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <label className="block text-sm font-medium">
            Name
            <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" />
          </label>
          <label className="block text-sm font-medium">
            Kind
            <select className="input mt-1" value={kind} onChange={(e) => setKind(e.target.value as "human" | "agent")}>
              <option value="human">Human: a person</option>
              <option value="agent">Agent: software acting for someone</option>
            </select>
          </label>
          {kind === "agent" && (
            <label className="block text-sm font-medium">
              Operated by
              <select className="input mt-1" value={operator} onChange={(e) => setOperator(e.target.value)}>
                <option value="">(nobody named)</option>
                {humans.map((h) => (
                  <option key={h.id} value={h.id}>{h.name || h.email}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <button className="btn btn-primary" disabled={pending}>
          Add actor
        </button>
      </form>
    </div>
  );
}
