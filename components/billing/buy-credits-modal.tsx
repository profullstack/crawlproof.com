"use client";

import { useCallback, useEffect, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";

type Token = {
  code: string;
  symbol: string;
  name: string;
  chain?: string;
};

type Step = "currency" | "payment";
type Status = "idle" | "pending" | "paid" | "expired" | "error";

type CreateResult = {
  ok: true;
  payment_id: string;
  address: string | null;
  amount_crypto: number | null;
  currency: string;
  expires_at: string | null;
  checkout_url: string | null;
  is_card: boolean;
} | { ok: false; error: string };

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
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [step, setStep] = useState<Step>("currency");
  const [picked, setPicked] = useState<Token | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<CreateResult | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [copied, setCopied] = useState<string | null>(null);

  // Lazy-load tokens when the modal opens.
  useEffect(() => {
    if (!open || tokens !== null) return;
    let cancelled = false;
    fetch("/api/credits/tokens")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setTokens(Array.isArray(data?.tokens) ? data.tokens : []);
      })
      .catch(() => !cancelled && setTokens([]));
    return () => {
      cancelled = true;
    };
  }, [open, tokens]);

  // Reset when closing.
  useEffect(() => {
    if (open) return;
    setStep("currency");
    setPicked(null);
    setPayment(null);
    setStatus("idle");
    setError(null);
    setCopied(null);
  }, [open]);

  const start = useCallback(
    async (token: Token) => {
      setPicked(token);
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/credits/create-invoice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ packId, currency: token.code }),
        });
        const data = (await res.json()) as CreateResult;
        if (!data.ok) {
          setError("error" in data ? data.error : "Could not create payment.");
          setLoading(false);
          return;
        }
        if (data.is_card && data.checkout_url) {
          window.location.href = data.checkout_url;
          return;
        }
        setPayment(data);
        setStep("payment");
        setStatus("pending");
      } catch {
        setError("Network error. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    [packId],
  );

  // Poll local DB status every 5s; webhook flips it to 'complete'.
  const poll = useCallback(async () => {
    if (!payment?.ok || !payment.payment_id) return;
    try {
      const res = await fetch(`/api/credits/status?payment_id=${payment.payment_id}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.status === "complete") setStatus("paid");
      else if (data.status === "failed") {
        setStatus("error");
        setError("Payment failed.");
      }
    } catch {
      /* keep polling */
    }
  }, [payment]);

  useEffect(() => {
    if (status !== "pending" || !payment?.ok) return;
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [status, payment, poll]);

  // Expiry watcher.
  useEffect(() => {
    if (!payment?.ok || !payment.expires_at || status !== "pending") return;
    const expiresAt = new Date(payment.expires_at).getTime();
    const ms = expiresAt - Date.now();
    if (ms <= 0) {
      setStatus("expired");
      return;
    }
    const t = setTimeout(() => setStatus("expired"), ms);
    return () => clearTimeout(t);
  }, [payment, status]);

  const copy = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(field);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* ignore */
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

        {status === "paid" && (
          <div className="space-y-3 text-center">
            <p className="text-lg font-semibold">Payment received</p>
            <p className="text-sm text-[var(--color-muted)]">
              {credits} credit{credits === 1 ? "" : "s"} added to your account.
            </p>
            <button className="btn btn-primary w-full" onClick={onClose}>
              Done
            </button>
          </div>
        )}

        {status === "expired" && (
          <div className="space-y-3 text-center">
            <p className="text-lg font-semibold">Payment expired</p>
            <p className="text-sm text-[var(--color-muted)]">
              The payment window closed before funds were received.
            </p>
            <button
              className="btn btn-primary w-full"
              onClick={() => {
                setPayment(null);
                setStep("currency");
                setStatus("idle");
                setPicked(null);
              }}
            >
              Try again
            </button>
          </div>
        )}

        {status === "pending" && step === "payment" && payment?.ok && payment.address && (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-semibold">Pay with {picked?.name ?? payment.currency}</span>
              <span className="text-[var(--color-muted)]">
                {payment.amount_crypto} {picked?.symbol ?? ""}
              </span>
            </div>
            <div className="flex justify-center">
              <div className="rounded-lg bg-white p-3">
                <QRCodeCanvas value={payment.address} size={208} level="M" />
              </div>
            </div>
            <FieldCopy
              label="Amount"
              value={`${payment.amount_crypto} ${picked?.symbol ?? ""}`}
              copyValue={String(payment.amount_crypto ?? "")}
              field="amt"
              copied={copied}
              onCopy={copy}
            />
            <FieldCopy
              label="Send to address"
              value={payment.address}
              copyValue={payment.address}
              field="addr"
              copied={copied}
              onCopy={copy}
              mono
            />
            {payment.expires_at && (
              <p className="text-xs text-[var(--color-muted)]">
                Expires {new Date(payment.expires_at).toLocaleTimeString()}
              </p>
            )}
            <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
              <span
                aria-hidden
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-accent)]"
              />
              <span>Listening for confirmation…</span>
            </div>
            <button
              className="w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg)]"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        )}

        {status === "idle" || (status === "pending" && step !== "payment") ? null : null}

        {status === "idle" && step === "currency" && (
          <CurrencyPicker tokens={tokens} loading={loading} onPick={start} />
        )}
      </div>
    </div>
  );
}

function CurrencyPicker({
  tokens,
  loading,
  onPick,
}: {
  tokens: Token[] | null;
  loading: boolean;
  onPick: (t: Token) => void;
}) {
  if (tokens === null) {
    return <p className="text-sm text-[var(--color-muted)]">Loading payment options…</p>;
  }
  if (tokens.length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        No payment options are available right now. Please try again later.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--color-muted)]">Pay with crypto:</p>
      <div className="grid grid-cols-2 gap-2">
        {tokens.map((t) => (
          <button
            key={t.code}
            type="button"
            disabled={loading}
            onClick={() => onPick(t)}
            className="rounded-md border border-[var(--color-border)] p-3 text-left hover:bg-[var(--color-bg)] disabled:opacity-50"
          >
            <div className="text-sm font-semibold">{t.symbol}</div>
            <div className="text-xs text-[var(--color-muted)]">
              {t.chain ?? t.name}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function FieldCopy({
  label,
  value,
  copyValue,
  field,
  copied,
  onCopy,
  mono,
}: {
  label: string;
  value: string;
  copyValue: string;
  field: string;
  copied: string | null;
  onCopy: (v: string, f: string) => void;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-[var(--color-muted)]">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code
          className={`flex-1 rounded-md bg-[var(--color-bg)] px-2 py-1.5 text-xs ${mono ? "break-all" : ""}`}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={() => onCopy(copyValue, field)}
          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-bg)]"
        >
          {copied === field ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
