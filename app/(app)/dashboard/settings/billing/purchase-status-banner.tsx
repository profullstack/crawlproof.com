"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Purchase = {
  id: string;
  coinpay_payment_id: string | null;
  status: string;
  credits_added: number;
};

export function PurchaseStatusBanner({ initial }: { initial: Purchase }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial.status);

  // Poll /api/credits/status while pending — the route's reconcile-from-coinpay
  // path will fail-fast if CoinPay shows expired, instead of leaving the user
  // on an optimistic green banner forever.
  useEffect(() => {
    if (status !== "pending" || !initial.coinpay_payment_id) return;
    const tick = async () => {
      try {
        const r = await fetch(
          `/api/credits/status?payment_id=${initial.coinpay_payment_id}`,
          { cache: "no-store" },
        );
        if (!r.ok) return;
        const data = await r.json();
        if (data.status === "complete") {
          setStatus("complete");
          router.refresh();
        } else if (data.status === "failed") {
          setStatus("failed");
          router.refresh();
        }
      } catch {
        /* keep polling */
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [status, initial.coinpay_payment_id, router]);

  if (status === "complete") {
    const n = initial.credits_added;
    return (
      <div className="card border-[rgba(52,211,153,0.4)] p-4 text-sm text-[var(--color-pass)]">
        Payment received — {n} credit{n === 1 ? "" : "s"} added to your balance.
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="card border-[rgba(251,191,36,0.4)] p-4 text-sm text-[var(--color-warn)]">
        Payment expired or failed before CoinPay confirmed it — your card was
        not charged. Please try again, or contact support if you were charged.
      </div>
    );
  }
  return (
    <div className="card p-4 text-sm">
      <span
        aria-hidden
        className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-accent)] align-[-2px]"
      />
      Awaiting confirmation from CoinPay… this usually clears in a few seconds.
    </div>
  );
}
