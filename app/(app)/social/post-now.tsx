"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { postNow } from "@/app/actions/socialPosting";

const BLUESKY_MAX = 300;
const MASTODON_MAX = 500;
const DISCORD_MAX = 2000;
const TELEGRAM_MAX = 4096;
const LINKEDIN_MAX = 3000;
const X_MAX = 280;
const REDDIT_TITLE_MAX = 300;

export function PostNowForm({
  accounts,
}: {
  accounts: Array<{ id: string; platform: string; handle: string }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [text, setText] = useState("");
  const [subreddit, setSubreddit] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const acct = accounts.find((a) => a.id === accountId);
  const isReddit = acct?.platform === "reddit";
  const charMax =
    acct?.platform === "bluesky"
      ? BLUESKY_MAX
      : acct?.platform === "x"
        ? X_MAX
        : acct?.platform === "mastodon"
          ? MASTODON_MAX
          : acct?.platform === "discord"
            ? DISCORD_MAX
            : acct?.platform === "telegram"
              ? TELEGRAM_MAX
              : acct?.platform === "linkedin"
                ? LINKEDIN_MAX
                : null;
  const remaining = charMax !== null ? charMax - text.length : null;
  const titleRemaining = isReddit ? REDDIT_TITLE_MAX - title.length : null;

  const canSubmit =
    !!accountId &&
    !!text.trim() &&
    (remaining === null || remaining >= 0) &&
    (!isReddit || (!!subreddit.trim() && !!title.trim() && titleRemaining! >= 0));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await postNow({
        accountId,
        text,
        ...(isReddit ? { subreddit, title } : {}),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setText("");
      setTitle("");
      // Keep subreddit between posts — users typically iterate on the same sub.
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
      {isReddit && (
        <>
          <div>
            <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Subreddit
            </label>
            <input
              className="input mt-1"
              type="text"
              placeholder="r/test"
              autoComplete="off"
              required
              value={subreddit}
              onChange={(e) => setSubreddit(e.target.value)}
            />
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Without the r/ — just the subreddit name. You need posting
              permissions there.
            </p>
          </div>
          <div>
            <label className="flex items-baseline justify-between text-xs uppercase tracking-wider text-[var(--color-muted)]">
              <span>Title</span>
              {titleRemaining !== null && (
                <span
                  className={
                    titleRemaining < 0
                      ? "text-[var(--color-fail)]"
                      : titleRemaining < 30
                        ? "text-[var(--color-warn)]"
                        : ""
                  }
                >
                  {titleRemaining}
                </span>
              )}
            </label>
            <input
              className="input mt-1"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        </>
      )}
      <div>
        <label className="flex items-baseline justify-between text-xs uppercase tracking-wider text-[var(--color-muted)]">
          <span>{isReddit ? "Body" : "Text"}</span>
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
          placeholder={isReddit ? "Post body (markdown supported)" : "What's on your mind?"}
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
        disabled={pending || !canSubmit}
      >
        {pending ? "Posting…" : "Post now"}
      </button>
    </form>
  );
}
