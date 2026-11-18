"use client";

import { useState } from "react";

/**
 * Sends the buyer to CoinPay's hosted checkout for a monitoring plan. Signed
 * out, it goes through signup first and comes back to the same plan.
 */
export function MonitorSubscribeButton({
  plan,
  token,
  subscriptionId,
  label,
  primary = true,
}: {
  plan: "solo" | "agency";
  token?: string | null;
  subscriptionId?: string | null;
  label: string;
  primary?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/monitor/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, token: token ?? null, subscriptionId: subscriptionId ?? null }),
      });
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.status === 401) {
        const back = `/monitor?plan=${plan}${token ? `&site=${encodeURIComponent(token)}` : ""}`;
        window.location.href = `/signup?redirect=${encodeURIComponent(back)}`;
        return;
      }
      if (!res.ok || !json.url) throw new Error(json.error || "Could not open checkout.");
      window.location.href = json.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open checkout.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={go} disabled={busy} className={`btn ${primary ? "btn-primary" : ""} w-full`}>
        {busy ? "Opening checkout…" : label}
      </button>
      {error && <p className="mt-2 text-sm text-[var(--color-fail)]">{error}</p>}
    </div>
  );
}
