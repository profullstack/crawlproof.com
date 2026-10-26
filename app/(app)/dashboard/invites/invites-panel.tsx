"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Invite = {
  id: string;
  createdAt: number;
  expiresAt: number | null;
  usedAt: number | null;
  note: string;
  status: "open" | "used" | "expired" | "revoked";
  usedByEmail?: string | null;
  bonus?: "granted" | "pending";
};

type Props = {
  origin: string;
  initial: {
    quota: { total: number; used: number; left: number };
    invites: Invite[];
    canInvite: boolean;
    blockedReason: string | null;
    unlocksAt: string | null;
  };
};

const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : "never");

export function InvitesPanel({ origin, initial }: Props) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ code: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const { quota, invites, canInvite, blockedReason, unlocksAt } = initial;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      if (!res.ok || !body.code) {
        setErr(body.error ?? "Could not create an invite.");
      } else {
        // The page's own origin, so a copied link never says localhost.
        setFresh({ code: body.code, url: `${origin}/i/${encodeURIComponent(body.code)}` });
        setNote("");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Withdraw this invite? The slot comes back to you.")) return;
    const res = await fetch(`/api/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(body.error ?? "Could not withdraw it.");
    }
    router.refresh();
  }

  async function copy() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the link is selectable on screen anyway */
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="text-sm text-[var(--color-muted)]">Invites left</div>
        <div className="mt-1 text-4xl font-extrabold">
          {quota.left}
          <span className="ml-2 text-base font-normal text-[var(--color-muted)]">of {quota.total}</span>
        </div>

        {canInvite ? (
          quota.left > 0 ? (
            <form onSubmit={create} className="mt-4 flex flex-col gap-2 sm:flex-row">
              <input
                className="input flex-1"
                placeholder="Who is it for? (only you see this)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={200}
                aria-label="Note"
              />
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "Creating..." : "Create invite"}
              </button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-[var(--color-muted)]">You have used all your invites.</p>
          )
        ) : (
          <p className="mt-3 text-sm text-[var(--color-muted)]">
            {blockedReason === "email not confirmed"
              ? "Confirm your email address to unlock invites."
              : unlocksAt
                ? `Invites unlock on ${new Date(unlocksAt).toLocaleDateString()}.`
                : "This account cannot send invites."}
          </p>
        )}
        {err && <p className="mt-2 text-sm text-[var(--color-fail)]">{err}</p>}

        {fresh && (
          <div className="mt-4 rounded border border-[var(--color-border)] p-3 text-sm">
            <div className="font-semibold">Your invite (shown once)</div>
            <div className="mt-1 break-all font-mono">{fresh.url}</div>
            <div className="mt-1 font-mono text-xs text-[var(--color-muted)]">Code: {fresh.code}</div>
            <button type="button" className="btn mt-2 text-xs" onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        )}
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Your invites</h2>
        {invites.length ? (
          <ul className="space-y-2">
            {invites.map((i) => (
              <li key={i.id} className="card flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div>
                  <div className="font-medium">{i.note || "Invite"}</div>
                  <div className="text-xs text-[var(--color-muted)]">
                    Created {day(i.createdAt)}
                    {i.status === "open" && ` · expires ${day(i.expiresAt)}`}
                    {i.status === "used" && ` · joined ${day(i.usedAt)}${i.usedByEmail ? ` (${i.usedByEmail})` : ""}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {i.status === "used" ? (
                    <span className={`badge ${i.bonus === "granted" ? "badge-pass" : "badge-warn"}`}>
                      {i.bonus === "granted" ? "bonus paid" : "bonus pending"}
                    </span>
                  ) : (
                    <span
                      className={`badge ${i.status === "open" ? "badge-unknown" : "badge-fail"}`}
                    >
                      {i.status}
                    </span>
                  )}
                  {i.status === "open" && (
                    <button type="button" className="text-xs underline" onClick={() => revoke(i.id)}>
                      Withdraw
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">No invites yet.</p>
        )}
      </section>
    </div>
  );
}
