"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState, useTransition } from "react";
import { sendRecentAuditOutreach } from "@/app/actions/recent-outreach";
import { OUTREACH_CREDITS } from "@/lib/credits";

export function RecentOutreachForm({
  auditId,
  organizationId,
  host,
  hasEmail,
  hasPhone,
  socialAccounts,
  creditsBalance,
}: {
  auditId: string;
  organizationId: string;
  host: string;
  hasEmail: boolean;
  hasPhone: boolean;
  socialAccounts: Array<{ id: string; platform: string; handle: string }>;
  creditsBalance: number;
}) {
  const initialChannel = hasEmail ? "email" : hasPhone ? "sms" : "social";
  const [channel, setChannel] = useState<"email" | "sms" | "social">(initialChannel);
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [socialAccountIds, setSocialAccountIds] = useState<string[]>([]);
  const [subject, setSubject] = useState(`Quick follow-up on your ${host} AEO audit`);
  const [body, setBody] = useState(defaultBody(host));
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const disabled = useMemo(
    () => (channel === "email" ? !hasEmail : channel === "sms" ? !hasPhone : false),
    [channel, hasEmail, hasPhone],
  );

  // Credit cost of the current action: 1 per email/SMS, 1 per selected social
  // account (a bare social "record" with no accounts is free).
  const cost = useMemo(
    () =>
      channel === "social"
        ? socialAccountIds.length * OUTREACH_CREDITS
        : OUTREACH_CREDITS,
    [channel, socialAccountIds],
  );
  const insufficient = cost > 0 && creditsBalance < cost;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await sendRecentAuditOutreach({
        auditId,
        organizationId,
        channel,
        visibility,
        socialAccountIds: channel === "social" ? socialAccountIds : [],
        subject,
        body,
      });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setMessage(
        channel === "social"
          ? socialAccountIds.length > 0
            ? `Posted via ${result.provider}.`
            : `Recorded via ${result.provider}.`
          : `Sent via ${result.provider}.`,
      );
    });
  }

  function toggleSocialAccount(accountId: string, checked: boolean) {
    setSocialAccountIds((current) =>
      checked
        ? [...new Set([...current, accountId])]
        : current.filter((id) => id !== accountId),
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
          <button
            type="button"
            onClick={() => setChannel("social")}
            className={`rounded border px-2 py-1 ${
              channel === "social"
                ? "border-[var(--color-accent)]"
                : "border-[var(--color-border)] text-[var(--color-muted)]"
            }`}
          >
            Social
          </button>
        </div>

        {(channel === "email" || channel === "social") && (
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

        {channel === "social" && (
          <div className="space-y-3">
            <label className="block text-xs">
              <span className="font-medium">Visibility</span>
              <select
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as typeof visibility)}
                className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-1.5"
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
              </select>
            </label>
            {socialAccounts.length > 0 && (
              <fieldset className="rounded border border-[var(--color-border)] bg-[var(--color-card)] p-2 text-xs">
                <legend className="px-1 font-medium">Post from</legend>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  {socialAccounts.map((account) => (
                    <label key={account.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={socialAccountIds.includes(account.id)}
                        onChange={(event) =>
                          toggleSocialAccount(account.id, event.target.checked)
                        }
                      />
                      <span className="min-w-0 truncate">
                        {account.platform} · {account.handle}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
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
          {insufficient ? (
            <Link href="/settings/billing" className="btn btn-primary text-xs">
              Buy credits to send
            </Link>
          ) : (
            <button
              type="submit"
              className="btn btn-primary text-xs"
              disabled={pending || disabled}
            >
              {pending
                ? channel === "social"
                  ? "Recording..."
                  : "Sending..."
                : channel === "social"
                  ? socialAccountIds.length > 0
                    ? "Post SOCIAL"
                    : "Record SOCIAL"
                  : `Send ${channel.toUpperCase()}`}
            </button>
          )}
          <span className="text-xs text-[var(--color-muted)]">
            {cost > 0 ? `${cost} credit${cost === 1 ? "" : "s"} · ` : "Free · "}
            balance {creditsBalance}
          </span>
          {message && (
            <p
              className={`text-xs ${
                message.startsWith("Sent") ||
                message.startsWith("Posted") ||
                message.startsWith("Recorded")
                  ? "text-green-700"
                  : "text-red-600"
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
