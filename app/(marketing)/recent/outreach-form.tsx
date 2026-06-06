"use client";

import { FormEvent, useMemo, useState, useTransition } from "react";
import { sendRecentAuditOutreach } from "@/app/actions/recent-outreach";

export function RecentOutreachForm({
  auditId,
  organizationId,
  host,
  hasEmail,
  hasPhone,
}: {
  auditId: string;
  organizationId: string;
  host: string;
  hasEmail: boolean;
  hasPhone: boolean;
}) {
  const initialChannel = hasEmail ? "email" : "sms";
  const [channel, setChannel] = useState<"email" | "sms">(initialChannel);
  const [subject, setSubject] = useState(`Quick follow-up on your ${host} AEO audit`);
  const [body, setBody] = useState(defaultBody(host));
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const disabled = useMemo(
    () => (channel === "email" ? !hasEmail : !hasPhone),
    [channel, hasEmail, hasPhone],
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await sendRecentAuditOutreach({
        auditId,
        organizationId,
        channel,
        subject,
        body,
      });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setMessage(`Sent via ${result.provider}.`);
    });
  }

  if (!hasEmail && !hasPhone) {
    return (
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        No captured email or phone for this scan.
      </p>
    );
  }

  return (
    <details className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Send outreach
      </summary>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <div className="flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            onClick={() => setChannel("email")}
            disabled={!hasEmail}
            className={`rounded border px-2 py-1 ${
              channel === "email"
                ? "border-[var(--color-accent)]"
                : "border-[var(--color-border)] text-[var(--color-muted)]"
            }`}
          >
            Email {hasEmail ? "" : "unavailable"}
          </button>
          <button
            type="button"
            onClick={() => setChannel("sms")}
            disabled={!hasPhone}
            className={`rounded border px-2 py-1 ${
              channel === "sms"
                ? "border-[var(--color-accent)]"
                : "border-[var(--color-border)] text-[var(--color-muted)]"
            }`}
          >
            SMS {hasPhone ? "" : "unavailable"}
          </button>
        </div>

        {channel === "email" && (
          <label className="block text-xs">
            <span className="font-medium">Subject</span>
            <input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5"
              maxLength={120}
            />
          </label>
        )}

        <label className="block text-xs">
          <span className="font-medium">Message</span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="mt-1 min-h-24 w-full rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5"
            maxLength={channel === "sms" ? 480 : 4000}
            required
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="btn btn-primary text-xs"
            disabled={pending || disabled}
          >
            {pending ? "Sending..." : `Send ${channel.toUpperCase()}`}
          </button>
          {message && (
            <p
              className={`text-xs ${
                message.startsWith("Sent") ? "text-green-700" : "text-red-600"
              }`}
            >
              {message}
            </p>
          )}
        </div>
      </form>
    </details>
  );
}

function defaultBody(host: string) {
  return `I saw your CrawlProof audit for ${host}. There are a few concrete fixes that would improve how AI engines understand the site.`;
}
