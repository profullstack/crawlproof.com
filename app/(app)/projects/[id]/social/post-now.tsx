"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { postNow, postNowFromUrl } from "@/app/actions/socialPosting";

const BLUESKY_MAX = 300;
const MASTODON_MAX = 500;
const DISCORD_MAX = 2000;
const TELEGRAM_MAX = 4096;
const LINKEDIN_MAX = 3000;
const X_MAX = 280;
const FACEBOOK_MAX = 5000;
const THREADS_MAX = 500;
const REDDIT_TITLE_MAX = 300;

// Classify a feed URL so the picker can group Software listings / Blog posts /
// News separately from tag/category/static "other" pages.
function kindOf(url: string): "blog" | "software" | "news" | "other" {
  if (/\/blog\//i.test(url)) return "blog";
  if (/\/software\//i.test(url)) return "software";
  if (/\/news\//i.test(url)) return "news";
  return "other";
}

export function PostNowForm({
  accounts,
  projectId,
  urls = [],
}: {
  accounts: Array<{ id: string; platform: string; handle: string }>;
  projectId: string;
  urls?: Array<{ url: string; title: string | null }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"manual" | "url">("manual");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [postToAll, setPostToAll] = useState(false);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [subreddit, setSubreddit] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const selectedIds = postToAll ? accounts.map((a) => a.id) : accountId ? [accountId] : [];
  const acct = postToAll ? undefined : accounts.find((a) => a.id === accountId);
  const hasReddit = postToAll
    ? accounts.some((a) => a.platform === "reddit")
    : acct?.platform === "reddit";
  const isReddit = !postToAll && acct?.platform === "reddit";
  const charMax = postToAll
    ? null
    : acct?.platform === "bluesky"
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
                : acct?.platform === "facebook_page"
                  ? FACEBOOK_MAX
                  : acct?.platform === "threads"
                    ? THREADS_MAX
                    : null;
  const remaining = charMax !== null ? charMax - text.length : null;
  const titleRemaining = hasReddit ? REDDIT_TITLE_MAX - title.length : null;

  const canSubmit =
    mode === "url"
      ? selectedIds.length > 0 && !!url.trim()
      : selectedIds.length > 0 &&
        !!text.trim() &&
        (remaining === null || remaining >= 0) &&
        (!hasReddit || (!!subreddit.trim() && !!title.trim() && titleRemaining! >= 0));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setStatusMsg(null);
    start(async () => {
      if (mode === "url") {
        setStatusMsg("Fetching page and generating posts…");
        const r = await postNowFromUrl({
          projectId,
          url,
          accountIds: selectedIds,
        });
        setStatusMsg(null);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setUrl("");
        setNotice(
          `Posted to ${r.posted} account${r.posted !== 1 ? "s" : ""}${r.errors.length ? ` (${r.errors.length} failed)` : ""}.`,
        );
        router.refresh();
        return;
      }
      // Manual mode — post to each selected account in sequence.
      let postedCount = 0;
      const errs: string[] = [];
      for (const id of selectedIds) {
        const acct = accounts.find((a) => a.id === id);
        const acctPlatform = acct?.platform;
        const label = acct ? `${acct.handle} (${acctPlatform})` : id;
        setStatusMsg(`Posting to ${label}…`);
        const needsReddit = acctPlatform === "reddit";
        const r = await postNow({
          accountId: id,
          text,
          ...(needsReddit ? { subreddit, title } : {}),
        });
        if (r.ok) postedCount++;
        else errs.push(`${acctPlatform ?? id}: ${r.error}`);
      }
      setStatusMsg(null);
      if (postedCount === 0) {
        setError(errs.join("; ") || "Nothing was posted.");
        return;
      }
      setText("");
      setTitle("");
      setNotice(
        postToAll
          ? `Posted to ${postedCount} account${postedCount !== 1 ? "s" : ""}${errs.length ? ` (${errs.length} failed)` : ""}.`
          : `Posted.`,
      );
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5 text-sm">
        <button
          type="button"
          onClick={() => setMode("manual")}
          className={`rounded-md px-3 py-1 ${mode === "manual" ? "bg-[var(--color-card)] text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
        >
          Write manually
        </button>
        <button
          type="button"
          onClick={() => setMode("url")}
          className={`rounded-md px-3 py-1 ${mode === "url" ? "bg-[var(--color-card)] text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
        >
          From URL (AI)
        </button>
      </div>
      <div>
        <div className="flex items-center justify-between">
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Post from
          </label>
          {accounts.length > 1 && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={postToAll}
                onChange={(e) => setPostToAll(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Post to all accounts ({accounts.length})
            </label>
          )}
        </div>
        {postToAll ? (
          <div className="input mt-1 text-sm text-[var(--color-muted)]">
            {accounts.map((a) => `${a.handle} (${a.platform})`).join(", ")}
          </div>
        ) : (
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
        )}
      </div>
      {mode === "url" && (
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Article URL
          </label>
          {urls.length > 0 && (
            <select
              className="input mt-1"
              value=""
              onChange={(e) => {
                if (e.target.value) setUrl(e.target.value);
              }}
            >
              <option value="">Pick from your feed…</option>
              {(
                [
                  ["blog", "Blog posts"],
                  ["software", "Software listings"],
                  ["news", "News"],
                  ["other", "Other pages"],
                ] as const
              ).map(([kind, label]) => {
                const inKind = urls.filter((u) => kindOf(u.url) === kind);
                if (inKind.length === 0) return null;
                return (
                  <optgroup key={kind} label={`${label} (${inKind.length})`}>
                    {inKind.slice(0, 50).map((u) => {
                      const t = (u.title || "").trim();
                      // Older items have a URL-slug/UUID title; show the URL then.
                      const uuidish = /^[0-9a-f]{8}[\s-]/i.test(t);
                      const optLabel = t && !uuidish ? `${t} — ${u.url}` : u.url;
                      return (
                        <option key={u.url} value={u.url}>
                          {optLabel}
                        </option>
                      );
                    })}
                  </optgroup>
                );
              })}
            </select>
          )}
          <input
            className="input mt-1"
            type="url"
            placeholder={urls.length > 0 ? "…or paste a URL" : "https://example.com/post"}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            We fetch the page, render it in your brand voice for each platform, and post immediately.
          </p>
        </div>
      )}
      {mode === "manual" && hasReddit && (
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
      {mode === "manual" && (
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
      )}
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={pending || !canSubmit}
      >
        {pending ? "Posting…" : mode === "url" ? "Generate & post" : "Post now"}
      </button>
      {statusMsg && (
        <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {statusMsg}
        </p>
      )}
    </form>
  );
}
