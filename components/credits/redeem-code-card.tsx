"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** "Have a code?" — redeem a CR-… credit code into scan credits. */
export function RedeemCodeCard() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/credits/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      setMsg({ ok: res.ok, text: body.message ?? body.error ?? (res.ok ? "Redeemed." : "Could not redeem that code.") });
      if (res.ok) {
        setCode("");
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: "Network error. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <h2 className="font-semibold">Have a code?</h2>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Someone handed you a CrawlProof credit code. Redeem it for scan credits.
      </p>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          className="input flex-1 font-mono"
          placeholder="CR-XXXX-XXXX-XXXX-XXXX"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label="Credit code"
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>
          {busy ? "Redeeming..." : "Redeem"}
        </button>
      </form>
      {msg && (
        <p
          role="status"
          className={`mt-2 text-sm ${msg.ok ? "text-[var(--color-pass)]" : "text-[var(--color-fail)]"}`}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}
