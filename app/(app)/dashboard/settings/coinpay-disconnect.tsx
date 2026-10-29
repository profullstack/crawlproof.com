"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { disconnectCoinpayAction } from "@/app/actions/coinpayIdentity";

export function CoinpayDisconnectButton() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-[var(--color-fail)]">{error}</span>}
      <button
        type="button"
        className="btn btn-secondary text-sm"
        disabled={pending}
        onClick={() => {
          if (!confirm("Disconnect CoinPay from this account?")) return;
          start(async () => {
            const r = await disconnectCoinpayAction();
            if (!r.ok) setError(r.error);
            else router.refresh();
          });
        }}
      >
        {pending ? "Disconnecting…" : "Disconnect"}
      </button>
    </div>
  );
}
