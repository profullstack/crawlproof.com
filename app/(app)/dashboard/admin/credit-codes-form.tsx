"use client";

import { useEffect, useState } from "react";

type CodeInfo = {
  id: string;
  label: string;
  grant: { amount: number };
  maxRedemptions: number;
  redemptions: number;
  expiresAt: number | null;
  createdAt: number;
  revokedAt: number | null;
};

/** Mint a scarce credit code to hand to someone; list and revoke existing ones. */
export function CreditCodesForm() {
  const [credits, setCredits] = useState("100");
  const [label, setLabel] = useState("");
  const [max, setMax] = useState("1");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [codes, setCodes] = useState<CodeInfo[]>([]);

  async function load() {
    const res = await fetch("/api/admin/credit-codes");
    if (res.ok) setCodes(((await res.json()) as { codes: CodeInfo[] }).codes ?? []);
  }
  useEffect(() => {
    void load();
  }, []);

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMinted(null);
    try {
      const res = await fetch("/api/admin/credit-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credits: Number(credits),
          label: label || undefined,
          max_redemptions: Number(max) || 1,
          expires_at: expires || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      if (!res.ok || !body.code) setError(body.error ?? "Mint failed.");
      else {
        setMinted(body.code);
        setLabel("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this code? Unredeemed uses stop working.")) return;
    await fetch(`/api/admin/credit-codes/${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="mt-3 space-y-4">
      <form onSubmit={mint} className="grid gap-2 sm:grid-cols-5">
        <input className="input" type="number" min={1} value={credits} onChange={(e) => setCredits(e.target.value)} aria-label="Credits" />
        <input className="input sm:col-span-2" placeholder="Label (who it is for)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input className="input" type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} aria-label="Max redemptions" title="Max redemptions" />
        <input className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} aria-label="Expires" title="Expires (optional)" />
        <button type="submit" className="btn btn-primary sm:col-span-5" disabled={busy}>
          {busy ? "Minting..." : "Mint credit code"}
        </button>
      </form>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {minted && (
        <div className="rounded border border-[var(--color-border)] p-3 text-sm">
          Shown once (only its hash is stored): <code className="select-all font-mono">{minted}</code>
        </div>
      )}
      {codes.length > 0 && (
        <ul className="space-y-1 text-sm">
          {codes.slice(0, 20).map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {c.label} · {c.grant.amount} cr · {c.redemptions}/{c.maxRedemptions} used
                {c.expiresAt ? ` · expires ${new Date(c.expiresAt).toLocaleDateString()}` : ""}
              </span>
              {c.revokedAt ? (
                <span className="badge badge-fail">revoked</span>
              ) : (
                <button type="button" className="text-xs underline" onClick={() => revoke(c.id)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
