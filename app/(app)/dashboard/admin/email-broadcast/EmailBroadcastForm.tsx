"use client";

import { useEffect, useMemo, useState } from "react";
import { markdownToEmailHtml } from "@/lib/emailMarkdown";

export function EmailBroadcastForm() {
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [skippedCount, setSkippedCount] = useState(0);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<
    | { type: "idle" }
    | { type: "loading" }
    | { type: "success"; sent: number; failed: number; skipped?: number }
    | { type: "error"; message: string }
  >({ type: "idle" });

  // Same renderer the send route uses, so the preview is the email.
  const previewHtml = useMemo(() => markdownToEmailHtml(body), [body]);

  useEffect(() => {
    fetch("/api/admin/email-broadcast")
      .then((r) => r.json())
      .then((d) => {
        setRecipientCount(d.count ?? null);
        setSkippedCount(d.skipped ?? 0);
      })
      .catch(() => setRecipientCount(null));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !body.trim()) return;

    setStatus({ type: "loading" });
    try {
      const res = await fetch("/api/admin/email-broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, markdown: body }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus({ type: "error", message: data.error ?? "Unknown error" });
      } else {
        setStatus({
          type: "success",
          sent: data.sent,
          failed: data.failed,
          skipped: data.skipped,
        });
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
        {skippedCount > 0 && (
          <span className="ml-1">
            {skippedCount} unsendable address
            {skippedCount === 1 ? "" : "es"} skipped.
          </span>
        )}
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
          rows={14}
          className="w-full rounded border border-[var(--color-border)] bg-transparent px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-pass)]"
          placeholder={
            "Paste or write markdown — plain text works too.\n\n# Heading\n\nSome **bold** text with a [link](https://crawlproof.com).\n\n- bullet one\n- bullet two"
          }
        />
        <p className="text-xs text-[var(--color-muted)]">
          Markdown is converted to HTML for the email: headings, bold, italics,
          links, images, code, quotes, bullet and numbered lists, rules. Plain
          text is fine as-is — line breaks are preserved. Pasted HTML is shown
          as text, not rendered.
        </p>
      </div>

      {body.trim() && (
        <div className="space-y-1">
          <div className="text-sm font-medium">Preview</div>
          <div className="rounded border border-[var(--color-border)] bg-[#12161c] p-5">
            {subject.trim() && (
              <h1 className="mb-4 text-[22px] font-extrabold leading-tight text-[#e7e9ee]">
                {subject}
              </h1>
            )}
            {/* Rendered by the same escaping renderer the route uses — not raw input. */}
            <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
          <p className="text-xs text-[var(--color-muted)]">
            Shown inside the CrawlProof email shell exactly as recipients will
            see it.
          </p>
        </div>
      )}

      {status.type === "success" && (
        <div className="rounded border border-[var(--color-pass)] bg-[var(--color-pass)]/10 px-4 py-3 text-sm">
          Sent {status.sent} email{status.sent === 1 ? "" : "s"} successfully.
          {status.failed > 0 && (
            <span className="ml-1 text-[var(--color-fail)]">
              {status.failed} failed.
            </span>
          )}
          {(status.skipped ?? 0) > 0 && (
            <span className="ml-1 text-[var(--color-muted)]">
              {status.skipped} unsendable address
              {status.skipped === 1 ? "" : "es"} skipped.
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
