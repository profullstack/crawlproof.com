"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addProgram,
  joinProgramAction,
  requestAffiliatePayout,
  rotateAffiliateToken,
  savePayAddress,
  saveWebhook,
  syncJoinAction,
} from "@/app/actions/affiliate";

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-[var(--color-bg-muted,rgba(127,127,127,.12))] px-2 py-1 font-mono text-sm" title={value}>
        {value}
      </code>
      <button
        type="button"
        className="btn text-sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked; the value is on screen */
          }
        }}
        aria-label={`Copy ${label}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function PayForm({ initial }: { initial: string }) {
  const router = useRouter();
  const [pay, setPay] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await savePayAddress({ pay });
          if (!res.ok) return setError(res.error);
          router.refresh();
        });
      }}
    >
      <input
        className="input min-w-0 flex-1 font-mono text-sm"
        placeholder="0x… (USDC on Polygon)"
        value={pay}
        onChange={(e) => setPay(e.target.value)}
        spellCheck={false}
      />
      <button className="btn btn-primary text-sm" disabled={pending}>
        {pending ? "Saving…" : "Save address"}
      </button>
      {error && <p className="w-full text-sm text-[var(--color-danger,#c0392b)]">{error}</p>}
    </form>
  );
}

export function WebhookForm({ initial }: { initial: string }) {
  const router = useRouter();
  const [url, setUrl] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await saveWebhook({ webhook: url });
          if (!res.ok) return setError(res.error);
          router.refresh();
        });
      }}
    >
      <input className="input min-w-0 flex-1 font-mono text-sm" placeholder="https://… (optional)" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
      <button className="btn text-sm" disabled={pending}>
        {pending ? "Saving…" : "Save webhook"}
      </button>
      {error && <p className="w-full text-sm text-[var(--color-danger,#c0392b)]">{error}</p>}
    </form>
  );
}

export function TokenButton({ prefix }: { prefix: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{prefix}…</span>
        <button
          type="button"
          className="btn text-sm"
          disabled={pending}
          onClick={() => {
            if (!window.confirm("Issue a new affiliate token? The current one stops working at once.")) return;
            setError(null);
            start(async () => {
              const res = await rotateAffiliateToken();
              if (!res.ok) return setError(res.error);
              setToken(res.token);
            });
          }}
        >
          {pending ? "…" : "New token"}
        </button>
      </div>
      {token && (
        <div className="space-y-1">
          <p className="text-sm text-[var(--color-muted)]">Shown once. It reads your ledger at /api/affiliate/v1/ledger.</p>
          <CopyField value={token} label="affiliate token" />
        </div>
      )}
      {error && <p className="text-sm text-[var(--color-danger,#c0392b)]">{error}</p>}
    </div>
  );
}

export function PayoutButton({ approved, min, hasAddress }: { approved: number; min: number; hasAddress: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const can = hasAddress && approved >= min;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn btn-primary text-sm"
        disabled={!can || pending}
        title={!hasAddress ? "Set a payout address first" : approved < min ? `Approved balance is under $${min}` : "Send the approved balance now"}
        onClick={() =>
          start(async () => {
            const res = await requestAffiliatePayout();
            setMsg(res.ok ? `Sent $${res.amount.toFixed(2)}${res.tx ? ` (tx ${res.tx.slice(0, 10)}…)` : ""}.` : res.error);
            if (res.ok) router.refresh();
          })
        }
      >
        {pending ? "Sending…" : "Pay out now"}
      </button>
      {msg && <span className="text-sm text-[var(--color-muted)]">{msg}</span>}
    </div>
  );
}

export function AddProgramForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        start(async () => {
          const res = await addProgram({ url });
          if (!res.ok) return setMsg(res.error);
          setMsg(`Read ${res.origin}: ${res.programs} program${res.programs === 1 ? "" : "s"}.${res.warnings.length ? ` ${res.warnings.join(" ")}` : ""}`);
          setUrl("");
          router.refresh();
        });
      }}
    >
      <input className="input min-w-0 flex-1 text-sm" placeholder="merchant.example (serves /.well-known/openaffiliate.json)" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button className="btn text-sm" disabled={pending || !url.trim()}>
        {pending ? "Reading…" : "Read merchant"}
      </button>
      {msg && <p className="w-full text-sm text-[var(--color-muted)]">{msg}</p>}
    </form>
  );
}

export function JoinButton({ origin, program, joined }: { origin: string; program: string; joined: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (joined) return <span className="badge">Joined</span>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn btn-primary text-sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await joinProgramAction({ origin, program });
            setMsg(res.ok ? (res.status === "pending" ? "Joined, pending the merchant's review." : "Joined.") : res.error);
            if (res.ok) router.refresh();
          })
        }
      >
        {pending ? "Joining…" : "Join"}
      </button>
      {msg && <span className="text-sm text-[var(--color-muted)]">{msg}</span>}
    </div>
  );
}

export function SyncButton({ id }: { id: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="btn text-sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await syncJoinAction({ id });
            setMsg(res.ok ? null : res.error);
            if (res.ok) router.refresh();
          })
        }
      >
        {pending ? "Reading…" : "Read ledger"}
      </button>
      {msg && <span className="text-sm text-[var(--color-danger,#c0392b)]">{msg}</span>}
    </div>
  );
}
