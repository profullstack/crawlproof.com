"use client";

import { useEffect, useState } from "react";

type CreateResult =
  | { ok: true; payment_id: string; checkout_url: string; expires_at: string | null }
  | { ok: false; error: string };

// Opens a CoinPay hosted checkout for the pack. The buyer picks any coin the
// business takes, or PayPal, on CoinPay's page and comes back to
// /dashboard/settings/billing?purchase=success, where the status banner polls
// until the webhook (or the poll fallback) credits the account.
export function BuyCreditsModal({
  open,
  onClose,
  packId,
  packLabel,
  amountUsd,
  credits,
}: {
  open: boolean;
  onClose: () => void;
  packId: string;
  packLabel: string;
  amountUsd: number;
  credits: number;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setLoading(false);
    setError(null);
  }, [open]);

  const start = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/credits/create-invoice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packId }),
      });
      const data = (await res.json()) as CreateResult;
      if (!data.ok || !data.checkout_url) {
        setError(!data.ok ? data.error : "Could not start checkout.");
        setLoading(false);
        return;
      }
      const url = new URL(data.checkout_url);
      if (url.protocol !== "https:") throw new Error("bad checkout url");
      window.location.assign(url.toString());
    } catch {
      setError("Could not start checkout. Please try again.");
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="card relative w-full max-w-md overflow-hidden p-6"
        role="dialog"
        aria-modal="true"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md px-2 py-1 text-[var(--color-muted)] hover:bg-[var(--color-bg)]"
        >
          ×
        </button>

        <header className="mb-4">
          <h2 className="text-lg font-semibold">Buy {packLabel}</h2>
          <p className="text-sm text-[var(--color-muted)]">
            {credits} credit{credits === 1 ? "" : "s"} · ${amountUsd.toFixed(2)} USD
          </p>
        </header>

        {error && (
          <div className="mb-3 rounded-md border border-[var(--color-fail)]/40 bg-[var(--color-fail)]/10 p-2 text-sm text-[var(--color-fail)]">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <p className="text-sm text-[var(--color-muted)]">
            You will pay on CoinPay&apos;s secure checkout. Pick USDC, USDT, BTC, ETH, SOL or
            another coin, or pay with PayPal. You come back here once it confirms.
          </p>
          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={loading}
            onClick={start}
          >
            {loading ? "Opening checkout…" : `Continue to checkout · $${amountUsd.toFixed(2)}`}
          </button>
          <button
            type="button"
            className="w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg)]"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
