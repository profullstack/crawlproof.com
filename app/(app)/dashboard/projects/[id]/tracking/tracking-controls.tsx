"use client";

import { useState, useTransition } from "react";
import {
  rotateEmailTrackingSecret,
  setEmailTrackingEnabled,
} from "@/app/actions/emailTracking";

type Examples = { base: string; open: string; click: string; unsubscribe: string; events: string };

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (iframe, old browser). The text is selectable anyway.
    }
  }
  return (
    <button type="button" onClick={copy} className="btn btn-secondary shrink-0 text-xs">
      {copied ? "Copied" : label}
    </button>
  );
}

function CodeRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        <CopyButton text={value} />
      </div>
      <pre className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
        <code>{value}</code>
      </pre>
      {hint && <p className="text-xs text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

export function TrackingControls({
  projectId,
  initialEnabled,
  canEdit,
  secret: initialSecret,
  rotatedAt,
  examples,
}: {
  projectId: string;
  initialEnabled: boolean;
  canEdit: boolean;
  secret: string | null;
  rotatedAt: string | null;
  examples: Examples;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [secret, setSecret] = useState(initialSecret);
  const [revealed, setRevealed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function flip() {
    const next = !enabled;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await setEmailTrackingEnabled({ projectId, enabled: next });
      if (!res.ok) return setError(res.error);
      setEnabled(res.enabled);
    });
  }

  function rotate() {
    if (
      !window.confirm(
        "Rotate the secret? Links already sent keep working until the next rotation. Update the secret in your sending tool right away.",
      )
    ) {
      return;
    }
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await rotateEmailTrackingSecret({ projectId });
      if (!res.ok) return setError(res.error);
      setSecret(res.secret);
      setRevealed(true);
      setNotice("New secret created. Links signed with the old one still verify until you rotate again.");
    });
  }

  const masked = secret ? `${"•".repeat(16)}${secret.slice(-4)}` : "";

  const pixelTag = `<img src="${examples.open}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;
  const headers = `List-Unsubscribe: <${examples.unsubscribe}>\nList-Unsubscribe-Post: List-Unsubscribe=One-Click`;
  const signSnippet = `import { createHmac } from "node:crypto";
const sig = (secret, value) => createHmac("sha256", secret).update(value).digest("hex").slice(0, 32);

// Click link: sign the destination URL exactly as it appears in u (before URL-encoding it into the query).
const u = "https://example.com/pricing";
const click = \`${examples.base}/c?u=\${encodeURIComponent(u)}&m=\${msgId}&c=launch&v=a&s=\${sig(SECRET, u)}\`;

// Unsubscribe link: sign the lowercased address.
const e = "Person@Example.com";
const unsub = \`${examples.base}/u?m=\${msgId}&c=launch&e=\${encodeURIComponent(e)}&s=\${sig(SECRET, e.toLowerCase())}\`;`;
  const eventsCurl = `curl -H "Authorization: Bearer $CRAWLPROOF_TRACKING_SECRET" \\
  "${examples.events}?since=2026-01-01T00:00:00Z&type=unsubscribe"`;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold">
              Email tracking is{" "}
              <span className={enabled ? "text-green-600" : "text-[var(--color-muted)]"}>
                {enabled ? "on" : "off"}
              </span>
            </p>
            <p className="text-sm text-[var(--color-muted)]">
              {enabled
                ? "Opens and clicks on the URLs below are being recorded."
                : "One click turns it on. There is nothing else to set up."}{" "}
              Unsubscribe links always work, even while tracking is off.
            </p>
          </div>
          {canEdit ? (
            <button
              type="button"
              onClick={flip}
              disabled={pending}
              className={`btn ${enabled ? "btn-secondary" : "btn-primary"}`}
            >
              {pending ? "…" : enabled ? "Disable email tracking" : "Enable email tracking"}
            </button>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">Read-only access</p>
          )}
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        {notice && <p className="mt-2 text-sm text-green-600">{notice}</p>}
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <CodeRow label="Tracking URL" value={examples.base} />

        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Secret</p>
            {secret && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setRevealed((r) => !r)}
                  className="btn btn-secondary text-xs"
                >
                  {revealed ? "Hide" : "Reveal"}
                </button>
                <CopyButton text={secret} />
                {canEdit && (
                  <button
                    type="button"
                    onClick={rotate}
                    disabled={pending}
                    className="btn btn-secondary text-xs"
                  >
                    Rotate
                  </button>
                )}
              </div>
            )}
          </div>
          {secret ? (
            <pre className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
              <code>{revealed ? secret : masked}</code>
            </pre>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">
              Only project owners and editors can see the secret.
            </p>
          )}
          <p className="text-xs text-[var(--color-muted)]">
            Signs click and unsubscribe links, and is the Bearer token for the events API.
            Keep it in your sending tool, never in an email.
            {rotatedAt ? ` Last rotated ${new Date(rotatedAt).toISOString().slice(0, 10)}.` : ""}
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <div>
          <h3 className="font-semibold">Copy-paste examples</h3>
          <p className="text-sm text-[var(--color-muted)]">
            <code>m</code> is your message id (one per recipient per email), <code>c</code> the
            campaign and <code>v</code> the A/B variant. All three are optional but the stats
            are grouped by them. <code>s</code> is the first 32 hex characters of
            HMAC-SHA256(secret, value).
          </p>
        </div>
        <CodeRow
          label="Open pixel"
          value={pixelTag}
          hint="Always returns a transparent 1x1 PNG, even when tracking is off, so it never shows as a broken image."
        />
        <CodeRow
          label="Tracked link"
          value={examples.click}
          hint="s signs u. A link with a missing or wrong signature is not redirected; the visitor sees the address as plain text instead."
        />
        <CodeRow
          label="Unsubscribe link"
          value={examples.unsubscribe}
          hint="s signs the lowercased email address. Shows a one-button confirmation page. Works even after tracking is turned off."
        />
        <CodeRow
          label="Unsubscribe headers (one-click, RFC 8058)"
          value={headers}
          hint="Lets Gmail and Apple Mail show their own unsubscribe button, which posts straight to the same URL."
        />
        <CodeRow label="Signing links (Node.js)" value={signSnippet} />
        <CodeRow
          label="Pull events (unsubscribes, A/B results)"
          value={eventsCurl}
          hint="Returns { events, next }. When next is not null, GET it for the following page."
        />
      </section>
    </div>
  );
}
