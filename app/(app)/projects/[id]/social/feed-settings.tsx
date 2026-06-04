"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveFeedAutopostSettings } from "@/app/actions/socialPosting";
import type { FeedType } from "@/lib/sp/feedAutopost";

type Account = {
  id: string;
  platform: string;
  handle: string;
};

type FeedConfig = {
  enabled: boolean;
  feed_type: FeedType;
  feed_url: string | null;
  ignore_paths: string[] | null;
  status: string;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_item_at: string | null;
  last_error: string | null;
};

export function FeedSettingsForm({
  projectId,
  accounts,
  config,
  autopostAccountIds,
  projectUrl,
}: {
  projectId: string;
  accounts: Account[];
  config: FeedConfig | null;
  autopostAccountIds: string[];
  projectUrl?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [checking, setChecking] = useState(false);
  const [checkStatus, setCheckStatus] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [feedType, setFeedType] = useState<FeedType>(config?.feed_type ?? "sitemap");
  const suggestedSitemapUrl = projectUrl
    ? `${projectUrl.replace(/\/$/, "")}/sitemap.xml`
    : null;
  const [feedUrl, setFeedUrl] = useState(
    config?.feed_url ?? suggestedSitemapUrl ?? "",
  );
  const [ignorePaths, setIgnorePaths] = useState(
    (config?.ignore_paths ?? ["/terms", "/privacy", "/contact"]).join("\n"),
  );
  const [selected, setSelected] = useState(new Set(autopostAccountIds));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function toggleAccount(accountId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(accountId);
      else next.delete(accountId);
      return next;
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await saveFeedAutopostSettings({
        projectId,
        enabled,
        feedType,
        feedUrl,
        ignorePaths,
        autopostAccountIds: [...selected],
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Saved.");
      router.refresh();
    });
  }

  function checkNow() {
    setError(null);
    setNotice(null);
    setChecking(true);
    setCheckStatus("Starting…");

    const es = new EventSource(
      `/api/social/feed-check?projectId=${encodeURIComponent(projectId)}`,
    );

    es.addEventListener("status", (e) => {
      try {
        setCheckStatus((JSON.parse(e.data) as { message: string }).message);
      } catch {}
    });

    es.addEventListener("done", (e) => {
      es.close();
      setChecking(false);
      setCheckStatus(null);
      try {
        const result = JSON.parse(e.data) as {
          ok: boolean;
          error?: string;
          checked?: number;
          newItems?: number;
          posted?: number;
          seeded?: number;
        };
        if (!result.ok) {
          setError(result.error ?? "Feed check failed.");
          return;
        }
        const seeded =
          (result.seeded ?? 0) > 0
            ? ` Seeded ${result.seeded} existing item(s).`
            : "";
        setNotice(
          `Checked ${result.checked ?? 0} item(s), found ${result.newItems ?? 0} new, posted ${result.posted ?? 0}.${seeded}`,
        );
        router.refresh();
      } catch {
        setError("Unexpected response from feed check.");
      }
    });

    es.addEventListener("error", () => {
      es.close();
      setChecking(false);
      setCheckStatus(null);
      setError("Feed check failed. Check the feed URL and try again.");
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className={
              "badge " +
              (config?.status === "ok"
                ? "badge-pass"
                : config?.status === "error"
                  ? "badge-fail"
                  : "badge-warn")
            }
          >
            {config?.status ?? "not configured"}
          </span>
          <span className="text-xs text-[var(--color-muted)]">
            Last checked {fmtDate(config?.last_checked_at ?? null)}
          </span>
        </div>
        {config?.last_error && (
          <p className="mt-2 text-xs text-[var(--color-fail)]">{config.last_error}</p>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Enable feed autopost</span>
      </label>

      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Feed source
        </label>
        <div className="mt-1 grid grid-cols-2 overflow-hidden rounded-md border border-[var(--color-border)]">
          {(["sitemap", "rss"] as FeedType[]).map((type) => (
            <button
              key={type}
              type="button"
              className={
                "px-3 py-2 text-sm " +
                (feedType === type
                  ? "bg-[var(--color-fg)] text-[var(--color-bg)]"
                  : "bg-[var(--color-bg)] text-[var(--color-fg)]")
              }
              onClick={() => setFeedType(type)}
            >
              {type === "sitemap" ? "Sitemap" : "RSS / Atom"}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-baseline gap-2">
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Feed URL
          </label>
          {feedType === "sitemap" && suggestedSitemapUrl && feedUrl !== suggestedSitemapUrl && (
            <button
              type="button"
              className="text-xs text-[var(--color-accent)] hover:underline"
              onClick={() => setFeedUrl(suggestedSitemapUrl)}
            >
              use {suggestedSitemapUrl}
            </button>
          )}
        </div>
        <input
          className="input mt-1"
          type="url"
          placeholder={
            feedType === "sitemap"
              ? (suggestedSitemapUrl ?? "https://example.com/sitemap.xml")
              : "https://example.com/feed.xml"
          }
          value={feedUrl}
          onChange={(e) => setFeedUrl(e.target.value)}
        />
        {feedType === "sitemap" && (
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Leave blank to auto-detect (checks robots.txt, /sitemap.xml, /sitemap_index.xml).
          </p>
        )}
      </div>

      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Ignore paths
        </label>
        <textarea
          className="input mt-1 min-h-[6rem]"
          value={ignorePaths}
          onChange={(e) => setIgnorePaths(e.target.value)}
        />
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Autopost accounts
        </h3>
        {accounts.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Connect an account before enabling autopost.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
            {accounts.map((account) => (
              <li
                key={account.id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <div>
                  <div className="font-medium">{account.handle}</div>
                  <div className="text-xs text-[var(--color-muted)]">
                    {account.platform}
                  </div>
                </div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.has(account.id)}
                    onChange={(e) => toggleAccount(account.id, e.target.checked)}
                  />
                  <span>Autopost</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}

      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving..." : "Save feed settings"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={checking || !enabled}
          onClick={checkNow}
        >
          Check feed now
        </button>
      </div>

      {checkStatus && (
        <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {checkStatus}
        </p>
      )}
    </form>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
