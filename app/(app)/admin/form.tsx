"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  grantCredits,
  revealVu1nzIntegrationToken,
  saveVu1nzIntegration,
} from "@/app/actions/admin";

export function GrantCreditsForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const n = parseInt(credits, 10);
    if (!Number.isFinite(n)) {
      setError("Credits must be a whole number (positive or negative).");
      return;
    }
    start(async () => {
      const res = await grantCredits({
        email: email.trim(),
        credits: n,
        reason: reason.trim() || undefined,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNotice(
        `${n >= 0 ? "+" : ""}${n} credits applied to ${email.trim()} — new balance ${res.newBalance}.`,
      );
      setCredits("");
      setReason("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Recipient email
        </label>
        <input
          className="input mt-1"
          type="email"
          placeholder="user@example.com"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr]">
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Credits (± int)
          </label>
          <input
            className="input mt-1 font-mono"
            type="number"
            step="1"
            placeholder="100"
            required
            value={credits}
            onChange={(e) => setCredits(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Reason (optional)
          </label>
          <input
            className="input mt-1"
            type="text"
            maxLength={280}
            placeholder="comp credits / refund / promo / etc."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </div>

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && (
        <p className="text-sm text-[var(--color-pass)]">{notice}</p>
      )}

      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Granting…" : "Grant credits"}
        </button>
      </div>
    </form>
  );
}

export function Vu1nzIntegrationForm({
  configured,
  status,
  updatedAt,
  endpoint,
}: {
  configured: boolean;
  status: string;
  updatedAt: string | null;
  endpoint: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [apiToken, setApiToken] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [revealing, startReveal] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await saveVu1nzIntegration({ apiToken });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setApiToken("");
      setRevealedToken(null);
      setNotice("Vu1nz API token saved.");
      router.refresh();
    });
  }

  function clear() {
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await saveVu1nzIntegration({ clear: true });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setApiToken("");
      setRevealedToken(null);
      setNotice("Vu1nz API token cleared.");
      router.refresh();
    });
  }

  function reveal() {
    setError(null);
    setNotice(null);
    startReveal(async () => {
      const res = await revealVu1nzIntegrationToken();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setRevealedToken(res.apiToken);
      setNotice("Vu1nz API token revealed.");
    });
  }

  function hide() {
    setRevealedToken(null);
    setNotice(null);
  }

  function copy() {
    setError(null);
    setNotice(null);
    startReveal(async () => {
      let apiToken = revealedToken;
      if (!apiToken) {
        const res = await revealVu1nzIntegrationToken();
        if (!res.ok) {
          setError(res.error);
          return;
        }
        apiToken = res.apiToken;
        setRevealedToken(apiToken);
      }
      try {
        await navigator.clipboard.writeText(apiToken);
        setNotice("Vu1nz API token copied.");
      } catch {
        setError("Could not copy token to clipboard.");
      }
    });
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span
          className={
            configured
              ? "rounded border border-[var(--color-pass)]/40 bg-[var(--color-pass)]/10 px-2 py-1 text-[var(--color-pass)]"
              : "rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-2 py-1 text-[var(--color-warn)]"
          }
        >
          {configured ? "Configured" : "Not configured"}
        </span>
        <span className="text-[var(--color-muted)]">Status: {status}</span>
        {updatedAt && (
          <span className="text-[var(--color-muted)]">
            Updated {new Date(updatedAt).toLocaleString()}
          </span>
        )}
      </div>

      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          API endpoint
        </label>
        <input className="input mt-1 font-mono text-sm" value={endpoint} readOnly />
      </div>

      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Vu1nz API token
        </label>
        <input
          className="input mt-1 font-mono"
          type="password"
          placeholder={configured ? "Paste replacement token" : "vk_live_..."}
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          autoComplete="off"
        />
      </div>

      {configured && (
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Stored token
          </label>
          <div className="mt-1 grid gap-2 sm:grid-cols-[1fr_auto]">
            <input
              className="input font-mono"
              type={revealedToken ? "text" : "password"}
              value={revealedToken ?? "stored-vu1nz-api-token"}
              readOnly
            />
            <div className="flex flex-wrap gap-2">
              {revealedToken ? (
                <button type="button" className="btn" onClick={hide}>
                  Hide
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={revealing || pending}
                  onClick={reveal}
                >
                  {revealing ? "Revealing..." : "Reveal"}
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={revealing || pending}
                onClick={copy}
              >
                {revealing ? "Working..." : "Copy"}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}

      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving..." : "Save Vu1nz token"}
        </button>
        {configured && (
          <button type="button" className="btn" disabled={pending} onClick={clear}>
            Clear token
          </button>
        )}
      </div>
    </form>
  );
}
