"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  connectBluesky,
  connectDiscord,
  connectTelegram,
  disconnectAccount,
} from "@/app/actions/socialPosting";

export function ConnectBlueskyForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [handle, setHandle] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await connectBluesky({ handle, appPassword });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setNotice("Connected. You can post from the social dashboard.");
      setAppPassword("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Handle
        </label>
        <input
          className="input mt-1"
          type="text"
          placeholder="you.bsky.social"
          autoComplete="off"
          required
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
      </div>
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          App password
        </label>
        <input
          className="input mt-1 font-mono"
          type="text"
          placeholder="xxxx-xxxx-xxxx-xxxx"
          autoComplete="off"
          spellCheck={false}
          required
          value={appPassword}
          onChange={(e) => setAppPassword(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          App password, NOT your main Bluesky password. Generate at{" "}
          bsky.app → Settings → App Passwords.
        </p>
      </div>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={pending || !handle || !appPassword}
      >
        {pending ? "Connecting…" : "Connect Bluesky"}
      </button>
    </form>
  );
}

export function ConnectDiscordForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await connectDiscord({ webhookUrl });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setNotice("Connected. You can post from the social dashboard.");
      setWebhookUrl("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Webhook URL
        </label>
        <input
          className="input mt-1 font-mono text-xs"
          type="url"
          placeholder="https://discord.com/api/webhooks/…"
          autoComplete="off"
          spellCheck={false}
          required
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          In your Discord channel: Edit Channel → Integrations → Webhooks →
          New Webhook → Copy URL. The URL is the secret; we encrypt it at
          rest.
        </p>
      </div>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={pending || !webhookUrl}
      >
        {pending ? "Connecting…" : "Connect Discord channel"}
      </button>
    </form>
  );
}

export function ConnectTelegramForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [botToken, setBotToken] = useState("");
  const [channel, setChannel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await connectTelegram({ botToken, channel });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setNotice("Connected. You can post from the social dashboard.");
      setBotToken("");
      setChannel("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Bot token
        </label>
        <input
          className="input mt-1 font-mono text-xs"
          type="text"
          placeholder="123456789:ABCdef…"
          autoComplete="off"
          spellCheck={false}
          required
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Get one from @BotFather on Telegram. We encrypt it at rest.
        </p>
      </div>
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Channel
        </label>
        <input
          className="input mt-1"
          type="text"
          placeholder="@yourchannel"
          autoComplete="off"
          required
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          The @username of a public channel, or the numeric id of a private
          channel (starts with <code>-100</code>). Add your bot as an admin
          with “Post Messages” permission first.
        </p>
      </div>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={pending || !botToken || !channel}
      >
        {pending ? "Connecting…" : "Connect Telegram channel"}
      </button>
    </form>
  );
}

export function DisconnectButton({
  accountId,
  handle,
}: {
  accountId: string;
  handle: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="text-xs text-[var(--color-fail)] hover:underline"
      disabled={pending}
      onClick={() => {
        if (!confirm(`Disconnect ${handle}? Queued posts will be deleted.`))
          return;
        start(async () => {
          await disconnectAccount(accountId);
          router.refresh();
        });
      }}
    >
      {pending ? "…" : "Disconnect"}
    </button>
  );
}
