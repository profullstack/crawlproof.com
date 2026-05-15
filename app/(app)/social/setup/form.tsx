"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  connectBluesky,
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
