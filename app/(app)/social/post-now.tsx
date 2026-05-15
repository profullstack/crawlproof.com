"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { postNow } from "@/app/actions/socialPosting";

const BLUESKY_MAX = 300;

export function PostNowForm({
  accounts,
}: {
  accounts: Array<{ id: string; platform: string; handle: string }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const acct = accounts.find((a) => a.id === accountId);
  const remaining =
    acct?.platform === "bluesky" ? BLUESKY_MAX - text.length : null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await postNow({ accountId, text });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setText("");
      setNotice(`Posted. View at ${r.webUrl}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Post from
        </label>
        <select
          className="input mt-1"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.handle} ({a.platform})
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="flex items-baseline justify-between text-xs uppercase tracking-wider text-[var(--color-muted)]">
          <span>Text</span>
          {remaining !== null && (
            <span
              className={
                remaining < 0
                  ? "text-[var(--color-fail)]"
                  : remaining < 30
                    ? "text-[var(--color-warn)]"
                    : ""
              }
            >
              {remaining}
            </span>
          )}
        </label>
        <textarea
          className="input mt-1 min-h-[8rem]"
          placeholder="What's on your mind?"
          required
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={pending || !accountId || !text.trim() || (remaining !== null && remaining < 0)}
      >
        {pending ? "Posting…" : "Post now"}
      </button>
    </form>
  );
}
