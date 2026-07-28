"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  connectMailboxAction,
  disconnectMailboxAction,
  discoverMailboxAction,
  type MailboxProposal,
} from "@/app/actions/mailbox";

export type ConnectedMailbox = {
  id: string;
  label: string;
  fromEmail: string | null;
  smtpHost: string | null;
  imapHost: string | null;
  discoveryDetail: string | null;
  verifiedAt: string | null;
};

const SOURCE_LABEL: Record<string, string> = {
  srv: "DNS SRV records",
  autoconfig: "autoconfig",
  "autoconfig-cname": "autoconfig (via CNAME)",
  "well-known": "/.well-known/autoconfig",
  autodiscover: "Outlook autodiscover",
  "autodiscover-cname": "Outlook autodiscover (via CNAME)",
  ispdb: "Mozilla's provider database",
  "mx-provider": "your MX records",
  convention: "a guess",
  manual: "entered by hand",
};

/**
 * Connect the user's own mailbox so outreach sends from their address rather
 * than a shared platform sender.
 *
 * Deliberately two steps. Discovery runs on the address alone and shows what
 * it found — and where it found it — and only then asks for a password. That
 * ordering is the point: a wrong hostname gets caught by the user reading it,
 * rather than by a real credential being sent to the wrong server.
 */
export function MailboxConnect({
  projectId,
  connected,
}: {
  projectId: string;
  connected: ConnectedMailbox | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [email, setEmail] = useState("");
  const [proposal, setProposal] = useState<MailboxProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Editable copies of what discovery proposed — "prompt for correctness"
  // means the user can fix any of it before the password is used.
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [password, setPassword] = useState("");

  function reset() {
    setProposal(null);
    setPassword("");
    setError(null);
    setNote(null);
  }

  function discover() {
    setError(null);
    setNote(null);
    start(async () => {
      const res = await discoverMailboxAction({ projectId, email });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const d = res.proposal.discovery;
      setProposal(res.proposal);
      setSmtpHost(d.smtp?.host ?? "");
      setSmtpPort(String(d.smtp?.port ?? 465));
      setSmtpSecure((d.smtp?.socket ?? "SSL") === "SSL");
      setImapHost(d.imap?.host ?? "");
      setImapPort(String(d.imap?.port ?? 993));
    });
  }

  function connect() {
    setError(null);
    setNote(null);
    start(async () => {
      const res = await connectMailboxAction({
        projectId,
        email,
        password,
        smtpHost,
        smtpPort: Number(smtpPort),
        smtpSecure,
        smtpUser: proposal?.discovery.smtp?.username ?? email,
        imapHost: imapHost || undefined,
        imapPort: imapHost ? Number(imapPort) : undefined,
        imapSecure: true,
        imapUser: proposal?.discovery.imap?.username ?? email,
        discoverySource: proposal?.discovery.source,
        discoveryDetail: proposal?.discovery.sourceDetail,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPassword("");
      setProposal(null);
      setNote(res.imapNote ?? "Mailbox connected and verified.");
      router.refresh();
    });
  }

  function disconnect(configId: string) {
    setError(null);
    setNote(null);
    start(async () => {
      const res = await disconnectMailboxAction({ projectId, configId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  if (connected && !open) {
    return (
      <section className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Sending mailbox</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Outreach sends as <strong>{connected.fromEmail ?? connected.label}</strong> via{" "}
              {connected.smtpHost}
              {connected.verifiedAt
                ? ` · last verified ${connected.verifiedAt.slice(0, 10)}`
                : ""}
            </p>
            {connected.discoveryDetail && (
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Settings {connected.discoveryDetail}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => {
                reset();
                setOpen(true);
              }}
              className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
            >
              Replace
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => disconnect(connected.id)}
              className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            >
              {pending ? "Removing..." : "Disconnect"}
            </button>
          </div>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </section>
    );
  }

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Sending mailbox</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Send outreach from your own address instead of the shared sender — replies land in your
            inbox and deliverability follows your domain. Enter the address and we&apos;ll look up
            the server settings from its DNS.
          </p>
        </div>
        {connected && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
          >
            Cancel
          </button>
        )}
      </div>

      {!proposal ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="min-w-56 flex-1">
            <span className="text-xs font-medium">Email address</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourdomain.com"
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={discover}
            disabled={pending || !email}
            className="rounded bg-[var(--color-fg)] px-3 py-1.5 text-sm text-[var(--color-bg)] disabled:opacity-50"
          >
            {pending ? "Looking up..." : "Look up settings"}
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {/* The confirmation step. Where the settings came from is shown as
              prominently as the settings themselves, because "we guessed" and
              "your domain published this" deserve different levels of trust. */}
          <div
            className={`rounded border p-3 text-sm ${
              proposal.discovery.confident
                ? "border-[var(--color-border)]"
                : "border-[var(--color-warn,#facc15)]"
            }`}
          >
            <p>
              <strong>
                {proposal.discovery.confident ? "Found settings" : "No settings published"}
              </strong>{" "}
              for {proposal.discovery.email} — {proposal.discovery.sourceDetail}.
            </p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Source: {SOURCE_LABEL[proposal.discovery.source] ?? proposal.discovery.source}. Check
              these against your mail host before continuing.
            </p>
          </div>

          {proposal.blocked && (
            <p className="rounded border border-[var(--color-warn,#facc15)] p-3 text-sm">
              {proposal.blocked}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="text-xs font-medium">SMTP host (sending)</span>
              <input
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5 text-sm"
              />
            </label>
            <label>
              <span className="text-xs font-medium">SMTP port</span>
              <input
                value={smtpPort}
                inputMode="numeric"
                onChange={(e) => setSmtpPort(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5 text-sm"
              />
            </label>
            <label>
              <span className="text-xs font-medium">IMAP host (reading replies)</span>
              <input
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5 text-sm"
              />
            </label>
            <label>
              <span className="text-xs font-medium">IMAP port</span>
              <input
                value={imapPort}
                inputMode="numeric"
                onChange={(e) => setImapPort(e.target.value)}
                className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5 text-sm"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={smtpSecure}
              onChange={(e) => setSmtpSecure(e.target.checked)}
            />
            <span>Implicit TLS on the SMTP port (leave on for 465, off for 587)</span>
          </label>

          {proposal.passwordNote && (
            <p className="rounded border border-[var(--color-border)] p-3 text-sm">
              {proposal.passwordNote}
            </p>
          )}

          <label className="block">
            <span className="text-xs font-medium">Mailbox password</span>
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5 text-sm"
            />
            <span className="mt-1 block text-xs text-[var(--color-muted)]">
              Encrypted with AES-256-GCM before it is stored, and only ever decrypted to send on
              your behalf. We log in once now to check it works — nothing is saved if that fails.
            </span>
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={connect}
              disabled={pending || !password || !smtpHost}
              className="rounded bg-[var(--color-fg)] px-3 py-1.5 text-sm text-[var(--color-bg)] disabled:opacity-50"
            >
              {pending ? "Verifying..." : "Verify and connect"}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={pending}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm"
            >
              Start over
            </button>
          </div>

          <details className="text-xs text-[var(--color-muted)]">
            <summary className="cursor-pointer">How we looked this up</summary>
            <ul className="mt-2 space-y-1">
              {proposal.discovery.attempts.map((a, i) => (
                <li key={i}>
                  {a.ok ? "✓" : "·"} {a.method} — {a.note}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {note && <p className="mt-2 text-sm">{note}</p>}
    </section>
  );
}
