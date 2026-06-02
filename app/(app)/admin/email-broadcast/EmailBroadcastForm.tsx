"use client";

import { useEffect, useState } from "react";

export function EmailBroadcastForm() {
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<
    | { type: "idle" }
    | { type: "loading" }
    | { type: "success"; sent: number; failed: number }
    | { type: "error"; message: string }
  >({ type: "idle" });

  useEffect(() => {
    fetch("/api/admin/email-broadcast")
      .then((r) => r.json())
      .then((d) => setRecipientCount(d.count ?? null))
      .catch(() => setRecipientCount(null));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !body.trim()) return;

    const html = body
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => `<p>${l}</p>`)
      .join("");

    setStatus({ type: "loading" });
    try {
      const res = await fetch("/api/admin/email-broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, html, text: body }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus({ type: "error", message: data.error ?? "Unknown error" });
      } else {
        setStatus({ type: "success", sent: data.sent, failed: data.failed });
        setSubject("");
        setBody("");
      }
    } catch (err) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="text-sm text-[var(--color-muted)]">
        {recipientCount === null
          ? "Loading recipient count…"
          : `${recipientCount} recipient${recipientCount === 1 ? "" : "s"} will receive this email.`}
      </div>

      <div className="space-y-1">
        <label htmlFor="subject" className="block text-sm font-medium">
          Subject
        </label>
        <input
          id="subject"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          required
          className="w-full rounded border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-pass)]"
          placeholder="Your email subject"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="body" className="block text-sm font-medium">
          Body
        </label>
        <textarea
          id="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          rows={10}
          className="w-full rounded border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-pass)]"
          placeholder="Write your message here. Each line becomes a paragraph."
        />
        <p className="text-xs text-[var(--color-muted)]">
          Each non-empty line will be wrapped in a &lt;p&gt; tag.
        </p>
      </div>

      {status.type === "success" && (
        <div className="rounded border border-[var(--color-pass)] bg-[var(--color-pass)]/10 px-4 py-3 text-sm">
          Sent {status.sent} email{status.sent === 1 ? "" : "s"} successfully.
          {status.failed > 0 && (
            <span className="ml-1 text-[var(--color-fail)]">
              {status.failed} failed.
            </span>
          )}
        </div>
      )}

      {status.type === "error" && (
        <div className="rounded border border-[var(--color-fail)] bg-[var(--color-fail)]/10 px-4 py-3 text-sm text-[var(--color-fail)]">
          Error: {status.message}
        </div>
      )}

      <button
        type="submit"
        disabled={status.type === "loading"}
        className="btn btn-primary text-sm disabled:opacity-50"
      >
        {status.type === "loading" ? "Sending…" : "Send broadcast"}
      </button>
    </form>
  );
}
