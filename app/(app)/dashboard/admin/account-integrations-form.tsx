"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  listSmsHubPlatformSenders,
  revealCoinPayPortalPlatformApiKey,
  revealSmsHubPlatformApiKey,
  saveCoinPayPortalPlatformIntegration,
  saveSmsHubPlatformIntegration,
} from "@/app/actions/admin";

type ConnectionStatus = {
  configured: boolean;
  hasApiKey: boolean;
  hasWebhookSecret?: boolean;
  status: string;
  updatedAt: string | null;
};

export function SmsHubConnectionForm({
  configured,
  hasApiKey,
  status,
  updatedAt,
  fromPhone,
  endpoint,
}: ConnectionStatus & { fromPhone: string; endpoint: string }) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [sender, setSender] = useState(fromPhone);
  const [senders, setSenders] = useState<Array<{ number: string; label: string }>>([]);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    start(async () => {
      const result = await saveSmsHubPlatformIntegration({ apiKey, fromPhone: sender });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setApiKey("");
      setRevealedKey(null);
      setMessage("SMSHub connected.");
      router.refresh();
    });
  }

  function disconnect() {
    if (!confirm("Disconnect SMSHub from CrawlProof?")) return;
    setMessage(null);
    start(async () => {
      const result = await saveSmsHubPlatformIntegration({ clear: true });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setApiKey("");
      setSender("");
      setRevealedKey(null);
      setMessage("SMSHub disconnected.");
      router.refresh();
    });
  }

  async function reveal() {
    setMessage(null);
    start(async () => {
      const result = await revealSmsHubPlatformApiKey();
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setRevealedKey(result.apiKey);
    });
  }

  function loadSenders() {
    setMessage(null);
    start(async () => {
      const result = await listSmsHubPlatformSenders({ apiKey });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setSenders(result.senders);
      setMessage(`Loaded ${result.senders.length} active SMSHub sender numbers. Choose the one CrawlProof should use.`);
    });
  }

  async function copyKey() {
    const key = revealedKey;
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setMessage("SMSHub key copied.");
    } catch {
      setMessage("Could not copy the SMSHub key.");
    }
  }

  return (
    <form onSubmit={save} className="mt-4 space-y-3">
      <ConnectionBadge configured={configured} status={status} updatedAt={updatedAt} />
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          SMSHub sender phone
        </label>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button type="button" className="btn" disabled={pending} onClick={loadSenders}>
            {pending ? "Loading…" : "Load account numbers"}
          </button>
          <span className="text-xs text-[var(--color-muted)]">
            Select the number CrawlProof should send from.
          </span>
        </div>
        {senders.length > 0 && (
          <select
            className="input mt-2 font-mono"
            value={sender}
            onChange={(event) => setSender(event.target.value)}
          >
            <option value="">Choose an active SMSHub number</option>
            {senders.map((item) => (
              <option key={item.number} value={item.number}>
                {item.label} — {item.number}
              </option>
            ))}
          </select>
        )}
        <input
          className="input mt-1 font-mono"
          value={sender}
          onChange={(event) => setSender(event.target.value)}
          placeholder={senders.length ? "Or enter a different number" : "+15551234567"}
          autoComplete="off"
        />
      </div>
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          SMSHub API key
        </label>
        <input
          className="input mt-1 font-mono"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasApiKey ? "Leave blank to keep the saved key" : "Paste API key"}
          autoComplete="new-password"
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Sent through <code>{endpoint}</code>. The key is sealed to your operator key.
        </p>
      </div>
      {hasApiKey && (
        <SecretControls
          value={revealedKey}
          onReveal={reveal}
          onHide={() => setRevealedKey(null)}
          onCopy={copyKey}
          disabled={pending}
          label="SMSHub key"
        />
      )}
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : configured ? "Update SMSHub" : "Connect SMSHub"}
        </button>
        {(configured || hasApiKey) && (
          <button type="button" className="btn" disabled={pending} onClick={disconnect}>
            Disconnect
          </button>
        )}
      </div>
    </form>
  );
}

export function CoinPayPortalConnectionForm({
  configured,
  hasApiKey,
  status,
  updatedAt,
  hasWebhookSecret,
  merchantId,
  apiUrl,
}: ConnectionStatus & { hasWebhookSecret: boolean; merchantId: string; apiUrl: string }) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [businessId, setBusinessId] = useState(merchantId);
  const [endpoint, setEndpoint] = useState(apiUrl);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    start(async () => {
      const result = await saveCoinPayPortalPlatformIntegration({
        apiKey,
        merchantId: businessId,
        apiUrl: endpoint,
      });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setApiKey("");
      setRevealedKey(null);
      setMessage("CoinPay Portal connected.");
      router.refresh();
    });
  }

  function disconnect() {
    if (!confirm("Disconnect CoinPay Portal from CrawlProof billing?")) return;
    setMessage(null);
    start(async () => {
      const result = await saveCoinPayPortalPlatformIntegration({ clear: true });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setApiKey("");
      setBusinessId("");
      setRevealedKey(null);
      setMessage("CoinPay Portal disconnected.");
      router.refresh();
    });
  }

  async function reveal() {
    setMessage(null);
    start(async () => {
      const result = await revealCoinPayPortalPlatformApiKey();
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setRevealedKey(result.apiKey);
    });
  }

  async function copyKey() {
    const key = revealedKey;
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setMessage("CoinPay Portal key copied.");
    } catch {
      setMessage("Could not copy the CoinPay Portal key.");
    }
  }

  return (
    <form onSubmit={save} className="mt-4 space-y-3">
      <ConnectionBadge configured={configured} status={status} updatedAt={updatedAt} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Business ID"
          value={businessId}
          onChange={setBusinessId}
          placeholder="CoinPay Portal business ID"
        />
        <TextField
          label="API endpoint"
          value={endpoint}
          onChange={setEndpoint}
          placeholder="https://coinpayportal.com"
        />
      </div>
      <TextField
        label="CoinPay Portal API key"
        value={apiKey}
        onChange={setApiKey}
        type="password"
        placeholder={hasApiKey ? "Leave blank to keep the saved key" : "Paste API key"}
      />
      {hasApiKey && (
        <SecretControls
          value={revealedKey}
          onReveal={reveal}
          onHide={() => setRevealedKey(null)}
          onCopy={copyKey}
          disabled={pending}
          label="CoinPay Portal key"
        />
      )}
      <p className="text-xs text-[var(--color-muted)]">
        Powers CrawlProof credit purchases and payouts. The API key is sealed to your operator key.
      </p>
      {configured && !hasWebhookSecret && (
        <p className="text-sm text-[var(--color-warn)]">
          The webhook signing secret is missing, so CoinPay payment callbacks
          cannot be verified yet.
        </p>
      )}
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : configured ? "Update CoinPay Portal" : "Connect CoinPay Portal"}
        </button>
        {(configured || hasApiKey) && (
          <button type="button" className="btn" disabled={pending} onClick={disconnect}>
            Disconnect
          </button>
        )}
      </div>
    </form>
  );
}

function ConnectionBadge({
  configured,
  status,
  updatedAt,
}: {
  configured: boolean;
  status: string;
  updatedAt: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span
        className={
          configured
            ? "rounded border border-[var(--color-pass)]/40 bg-[var(--color-pass)]/10 px-2 py-1 text-[var(--color-pass)]"
            : "rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-2 py-1 text-[var(--color-warn)]"
        }
      >
        {configured ? "Connected" : "Not connected"}
      </span>
      <span className="text-[var(--color-muted)]">Status: {status}</span>
      {updatedAt && (
        <span className="text-[var(--color-muted)]">
          Updated {new Date(updatedAt).toLocaleString()}
        </span>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </span>
      <input
        className="input mt-1 w-full font-mono"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
      />
    </label>
  );
}

function SecretControls({
  value,
  onReveal,
  onHide,
  onCopy,
  disabled,
  label,
}: {
  value: string | null;
  onReveal: () => void;
  onHide: () => void;
  onCopy: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
        Stored {label}
      </label>
      <div className="mt-1 grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          className="input font-mono"
          type={value ? "text" : "password"}
          value={value ?? "stored-encrypted-key"}
          readOnly
        />
        <div className="flex gap-2">
          {value ? (
            <button type="button" className="btn" onClick={onHide}>
              Hide
            </button>
          ) : (
            <button type="button" className="btn" disabled={disabled} onClick={onReveal}>
              Reveal
            </button>
          )}
          <button type="button" className="btn" disabled={disabled || !value} onClick={onCopy}>
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}

function FormMessage({ message }: { message: string | null }) {
  return message ? <p className="text-sm text-[var(--color-muted)]">{message}</p> : null;
}
