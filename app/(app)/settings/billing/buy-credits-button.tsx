"use client";

import { useState, useTransition } from "react";
import { startCreditPurchase } from "@/app/actions/coinpay";

export function BuyCreditsButton({ packId }: { packId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn btn-primary mt-4 w-full"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const res = await startCreditPurchase({ packId });
            if (res.ok) {
              window.location.href = res.url;
            } else {
              setError(res.error);
            }
          });
        }}
      >
        {pending ? "Opening CoinPay…" : "Buy with crypto"}
      </button>
      {error && <p className="mt-2 text-xs text-[var(--color-fail)]">{error}</p>}
    </>
  );
}
