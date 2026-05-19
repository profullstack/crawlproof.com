"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createIntegration,
  revokeIntegration,
  type IntegrationKind,
} from "@/app/actions/integrations";

type Integration = {
  id: string;
  name: string;
  kind: IntegrationKind;
  access_token: string;
  created_at: string;
  last_used_at: string | null;
  request_count: number;
};

const KIND_META: Record<IntegrationKind, { label: string; defaultName: string; webhookPath: string }> = {
  outrank: {
    label: "Outrank",
    defaultName: "Outrank",
    webhookPath: "/api/webhooks/outrank",
  },
  crawlproof: {
    label: "Crawlproof",
    defaultName: "Crawlproof",
    webhookPath: "/api/webhooks/crawlproof",
  },
};

function webhookUrlFor(kind: IntegrationKind): string {
  if (typeof window === "undefined") return KIND_META[kind].webhookPath;
  return `${window.location.origin}${KIND_META[kind].webhookPath}`;
}

export function IntegrationsManager({
  initial,
}: {
  initial: Integration[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [items, setItems] = useState<Integration[]>(initial);
  const [kind, setKind] = useState<IntegrationKind>("crawlproof");
  const [name, setName] = useState(KIND_META.crawlproof.defaultName);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justCreatedToken, setJustCreatedToken] = useState<string | null>(null);

  const onCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setJustCreatedToken(null);
    start(async () => {
      const res = await createIntegration({ name, kind });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setJustCreatedToken(res.accessToken);
      setName(KIND_META[kind].defaultName);
      router.refresh();
    });
  };

  const onRevoke = (it: Integration) => {
    if (
      !confirm(
        `Revoke this ${KIND_META[it.kind].label} integration? The source will stop being able to publish.`,
      )
    )
      return;
    start(async () => {
      const res = await revokeIntegration({ id: it.id });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setItems((prev) => prev.filter((i) => i.id !== it.id));
      router.refresh();
    });
  };

  const copy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Webhook endpoints
        </h3>
        <div className="mt-2 space-y-2">
          {(Object.keys(KIND_META) as IntegrationKind[]).map((k) => {
            const url = webhookUrlFor(k);
            return (
              <div key={k}>
                <div className="mb-1 text-sm font-medium">{KIND_META[k].label}</div>
                <div className="flex gap-2">
                  <code className="flex-1 break-all rounded border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-xs">
                    {url}
                  </code>
                  <button
                    type="button"
                    onClick={() => copy(`url-${k}`, url)}
                    className="btn"
                  >
                    {copied === `url-${k}` ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <form onSubmit={onCreate} className="space-y-3">
        <h3 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Generate token
        </h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[160px_1fr_auto]">
          <select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as IntegrationKind;
              setKind(k);
              setName(KIND_META[k].defaultName);
            }}
            className="input"
          >
            {(Object.keys(KIND_META) as IntegrationKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_META[k].label}
              </option>
            ))}
          </select>
          <input
            className="input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Integration name"
            maxLength={100}
            required
          />
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? "…" : "Generate"}
          </button>
        </div>
        {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
        {justCreatedToken && (
          <div className="rounded border border-[var(--color-pass)]/40 bg-[var(--color-pass)]/5 p-3 text-xs">
            <div className="mb-1 font-semibold text-[var(--color-pass)]">
              Token created — copy now (it stays visible below, but treat it
              as a secret).
            </div>
            <code className="break-all">{justCreatedToken}</code>
          </div>
        )}
      </form>

      <div>
        <h3 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Access tokens ({items.length})
        </h3>
        {items.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            None yet — generate one above.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {items.map((it) => {
              const revealedNow = !!revealed[it.id];
              const masked = `${it.access_token.slice(0, 8)}…${it.access_token.slice(-4)}`;
              return (
                <li
                  key={it.id}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-card)] p-3 text-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium">{it.name}</span>
                        <span className="badge">{KIND_META[it.kind]?.label ?? it.kind}</span>
                        <span className="text-xs text-[var(--color-muted)]">
                          {it.request_count} requests
                          {it.last_used_at &&
                            ` · last ${new Date(it.last_used_at).toLocaleString()}`}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <code className="flex-1 break-all rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs">
                          {revealedNow ? it.access_token : masked}
                        </code>
                        <button
                          type="button"
                          onClick={() =>
                            setRevealed((prev) => ({
                              ...prev,
                              [it.id]: !prev[it.id],
                            }))
                          }
                          className="text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                        >
                          {revealedNow ? "Hide" : "Reveal"}
                        </button>
                        <button
                          type="button"
                          onClick={() => copy(it.id, it.access_token)}
                          className="text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                        >
                          {copied === it.id ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRevoke(it)}
                      disabled={pending}
                      className="text-xs text-[var(--color-fail)] hover:underline"
                    >
                      Revoke
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
