"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createApiToken,
  revokeApiToken,
} from "@/app/actions/socialPosting";

type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function ApiTokensClient({ tokens }: { tokens: TokenRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [justMinted, setJustMinted] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await createApiToken({ name });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setJustMinted({ name, token: r.token });
      setName("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <section className="card p-5">
        <h2 className="text-lg font-semibold">New token</h2>
        <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[12rem]">
            <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Name
            </label>
            <input
              className="input mt-1"
              type="text"
              placeholder="sh1pt CLI on my laptop"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={pending || !name.trim()}
          >
            {pending ? "Minting…" : "Generate"}
          </button>
        </form>
        {error && <p className="mt-2 text-sm text-[var(--color-fail)]">{error}</p>}

        {justMinted && (
          <div className="mt-4 rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-3">
            <p className="text-sm font-semibold">
              Copy this token now — it will not be shown again.
            </p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              {justMinted.name}
            </p>
            <pre className="mt-2 overflow-x-auto rounded bg-[var(--color-bg-deep)] px-3 py-2 font-mono text-xs">
              {justMinted.token}
            </pre>
            <button
              type="button"
              className="btn mt-2 text-xs"
              onClick={() => {
                void navigator.clipboard.writeText(justMinted.token);
              }}
            >
              Copy
            </button>
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="text-lg font-semibold">Active tokens</h2>
        {tokens.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            No tokens yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--color-border)]">
            {tokens.map((t) => (
              <li
                key={t.id}
                className="flex items-baseline justify-between gap-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{t.name}</span>
                    <code className="text-xs text-[var(--color-muted)]">
                      {t.prefix}…
                    </code>
                    {t.revoked_at && (
                      <span className="badge badge-fail">revoked</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    Created {fmt(t.created_at)} · Last used {fmt(t.last_used_at)}
                    {t.revoked_at && ` · Revoked ${fmt(t.revoked_at)}`}
                  </p>
                </div>
                {!t.revoked_at && (
                  <RevokeButton tokenId={t.id} name={t.name} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RevokeButton({ tokenId, name }: { tokenId: string; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="text-xs text-[var(--color-fail)] hover:underline"
      disabled={pending}
      onClick={() => {
        if (!confirm(`Revoke ${name}? Tools using it will stop working.`)) return;
        start(async () => {
          await revokeApiToken(tokenId);
          router.refresh();
        });
      }}
    >
      {pending ? "…" : "Revoke"}
    </button>
  );
}
