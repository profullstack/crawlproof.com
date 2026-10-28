"use client";

import { useCallback, useEffect, useState } from "react";

type Endpoint = {
  id: string;
  url: string;
  events: string[];
  description: string;
  enabled: boolean;
  failures: number;
  disabled_reason: string | null;
  created_at: string;
};

type Delivery = {
  id: string;
  endpoint_id: string;
  event_type: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  payload?: { subject?: string } | unknown;
};

async function api<T>(siteId: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/webhooks${path}${path.includes("?") ? "&" : "?"}site=${encodeURIComponent(siteId)}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

export function WebhookManager({
  siteId,
  primaryId,
  eventTypes,
}: {
  siteId: string;
  primaryId: string | null;
  eventTypes: string[];
}) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState(eventTypes[0] ?? "*");

  const load = useCallback(async () => {
    try {
      const [e, d] = await Promise.all([
        api<{ endpoints: Endpoint[] }>(siteId, ""),
        api<{ deliveries: Delivery[] }>(siteId, "/deliveries?limit=25"),
      ]);
      setEndpoints(e.endpoints);
      setDeliveries(d.deliveries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const add = () =>
    run("add", async () => {
      const r = await api<{ endpoint: Endpoint; secret: string }>(siteId, "", {
        method: "POST",
        body: JSON.stringify({ url, description, events: events.split(/[,\s]+/).filter(Boolean) }),
      });
      setSecret({ id: r.endpoint.id, secret: r.secret });
      setUrl("");
      setDescription("");
    });

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}
      {secret && (
        <div className="rounded border border-[var(--color-border)] p-3 text-sm">
          <p>
            Signing secret for <code>{secret.id}</code>. Copy it now; it is the HMAC key and the bearer your
            receiver checks.
          </p>
          <code className="mt-2 block break-all font-mono text-xs">{secret.secret}</code>
          <button className="btn mt-2" onClick={() => setSecret(null)}>
            Done
          </button>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Endpoints</h2>
        {endpoints.length === 0 && <p className="text-sm text-[var(--color-muted)]">No endpoints yet.</p>}
        {endpoints.map((e) => (
          <div key={e.id} className="rounded border border-[var(--color-border)] p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="break-all font-mono text-xs">{e.url}</div>
                <div className="mt-1 text-xs text-[var(--color-muted)]">
                  {e.id === primaryId ? "autoblog · " : ""}
                  {e.description || "no description"} · events {e.events.join(", ")} ·{" "}
                  {e.enabled ? (
                    <span className="text-[var(--color-pass)]">on</span>
                  ) : (
                    <span className="text-[var(--color-warn)]">off{e.disabled_reason ? ` (${e.disabled_reason})` : ""}</span>
                  )}
                  {e.failures > 0 ? ` · ${e.failures} failures in a row` : ""}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn"
                  disabled={!!busy}
                  onClick={() =>
                    run(`test-${e.id}`, async () => {
                      const r = await api<{ ok: boolean; status: number | null; error: string | null }>(siteId, `/${e.id}/test`, { method: "POST" });
                      if (r.ok) setNotice(`Test delivered (HTTP ${r.status}).`);
                      else setError(`Test failed: ${r.error ?? `HTTP ${r.status}`}`);
                    })
                  }
                >
                  Test
                </button>
                <button
                  className="btn"
                  disabled={!!busy}
                  onClick={() =>
                    run(`secret-${e.id}`, async () => {
                      const r = await api<{ secret: string }>(siteId, `/${e.id}/secret`);
                      setSecret({ id: e.id, secret: r.secret });
                    })
                  }
                >
                  Show secret
                </button>
                <button
                  className="btn"
                  disabled={!!busy}
                  onClick={() => {
                    if (!confirm("Rotate the secret? The old one stops working at once; update your receiver.")) return;
                    void run(`rotate-${e.id}`, async () => {
                      const r = await api<{ secret: string }>(siteId, `/${e.id}/rotate`, { method: "POST" });
                      setSecret({ id: e.id, secret: r.secret });
                    });
                  }}
                >
                  Rotate
                </button>
                <button
                  className="btn"
                  disabled={!!busy}
                  onClick={() =>
                    run(`toggle-${e.id}`, async () => {
                      await api(siteId, `/${e.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !e.enabled }) });
                    })
                  }
                >
                  {e.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  className="btn"
                  disabled={!!busy}
                  onClick={() => {
                    if (!confirm(`Remove ${e.url}?`)) return;
                    void run(`delete-${e.id}`, async () => {
                      await api(siteId, `/${e.id}`, { method: "DELETE" });
                    });
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-2 rounded border border-[var(--color-border)] p-3">
        <h2 className="text-lg font-semibold">Add an endpoint</h2>
        <label className="block text-xs uppercase tracking-wider text-[var(--color-muted)]">
          URL (https)
          <input className="input mt-1" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/api/crawlproof-webhook" />
        </label>
        <label className="block text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Events
          <input className="input mt-1" value={events} onChange={(e) => setEvents(e.target.value)} />
        </label>
        <p className="text-xs text-[var(--color-muted)]">One of: {eventTypes.join(", ")}, or *.</p>
        <label className="block text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Description
          <input className="input mt-1" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <button className="btn btn-primary" disabled={!!busy || !url} onClick={() => void add()}>
          {busy === "add" ? "Adding…" : "Add endpoint"}
        </button>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Recent deliveries</h2>
        {deliveries.length === 0 && <p className="text-sm text-[var(--color-muted)]">Nothing sent yet.</p>}
        <ul className="space-y-1 text-xs">
          {deliveries.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2">
              <span className={d.status === "delivered" ? "text-[var(--color-pass)]" : d.status === "failed" ? "text-[var(--color-fail)]" : "text-[var(--color-warn)]"}>
                {d.status}
              </span>
              <span className="font-mono">{d.event_type}</span>
              <span className="text-[var(--color-muted)]">
                {(d.payload as { subject?: string } | undefined)?.subject ?? ""} · {new Date(d.created_at).toLocaleString()} · {d.attempts} attempt
                {d.attempts === 1 ? "" : "s"}
                {d.last_status ? ` · HTTP ${d.last_status}` : ""}
                {d.last_error ? ` · ${d.last_error}` : ""}
              </span>
              {d.status === "failed" && (
                <button
                  className="btn"
                  disabled={!!busy}
                  onClick={() =>
                    run(`retry-${d.id}`, async () => {
                      await api(siteId, `/deliveries/${d.id}/retry`, { method: "POST" });
                      setNotice("Queued again.");
                    })
                  }
                >
                  Retry
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
