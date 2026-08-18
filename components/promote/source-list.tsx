"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addFeedSource,
  addKeywordSources,
  removeSource,
  toggleSource,
} from "@/app/actions/promote";

export type PromoteSourceRow = {
  id: string;
  type: string;
  ownership: string;
  label: string;
  keyword: string | null;
  enabled: boolean;
  items_imported: number;
  last_ingested_at: string | null;
  feed_url: string | null;
  topic_slug: string | null;
  consecutive_failures: number;
  last_error: string | null;
};

const OWNERSHIP_LABELS: Record<string, string> = {
  owned: "Our content",
  partner: "Partner",
  shared: "Industry",
};

export function SourceList({
  listId,
  sources,
}: {
  listId: string;
  sources: PromoteSourceRow[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [keywords, setKeywords] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [feedOwnership, setFeedOwnership] = useState<"owned" | "partner" | "shared">("owned");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reset = () => {
    setError("");
    setNotice("");
  };

  const submitKeywords = (e: React.FormEvent) => {
    e.preventDefault();
    reset();
    start(async () => {
      const result = await addKeywordSources({ listId, keywords });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Report per keyword: "bitcoin added, zzz is not a topic yet" beats one
      // blanket success or failure.
      const failed = result.results.filter((r) => !r.ok);
      setNotice(
        `Added ${result.added} source${result.added !== 1 ? "s" : ""}.` +
          (failed.length
            ? ` Skipped: ${failed.map((f) => `${f.keyword} (${f.error})`).join(", ")}`
            : ""),
      );
      setKeywords("");
      router.refresh();
    });
  };

  const submitFeed = (e: React.FormEvent) => {
    e.preventDefault();
    reset();
    start(async () => {
      const result = await addFeedSource({ listId, feedUrl, ownership: feedOwnership });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`Added ${result.title ?? "the feed"}.`);
      setFeedUrl("");
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}

      {sources.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          No content sources yet. Add a keyword and this campaign keeps finding fresh
          links to post on its own.
        </p>
      ) : (
        <ul className="space-y-2">
          {sources.map((source) => (
            <li key={source.id} className="card p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{source.label}</span>
                    <span className="badge text-xs">
                      {OWNERSHIP_LABELS[source.ownership] ?? source.ownership}
                    </span>
                    {!source.enabled && <span className="badge text-xs">paused</span>}
                    {source.consecutive_failures > 0 && (
                      <span className="badge badge-fail text-xs">not responding</span>
                    )}
                  </div>
                  {source.feed_url && (
                    <a
                      href={source.feed_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate font-mono text-xs text-[var(--color-muted)] hover:underline"
                    >
                      {source.feed_url}
                    </a>
                  )}
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {source.items_imported} link{source.items_imported !== 1 ? "s" : ""} imported
                    {source.last_ingested_at
                      ? ` · last checked ${new Date(source.last_ingested_at).toLocaleString()}`
                      : " · not checked yet"}
                  </p>
                  {source.last_error && source.consecutive_failures > 0 && (
                    <p className="mt-1 text-xs text-[var(--color-fail)]">{source.last_error}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    className="btn text-xs"
                    onClick={() =>
                      start(async () => {
                        await toggleSource(source.id, !source.enabled);
                        router.refresh();
                      })
                    }
                  >
                    {source.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    className="btn text-xs"
                    onClick={() =>
                      start(async () => {
                        await removeSource(source.id);
                        router.refresh();
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submitKeywords} className="space-y-2">
        <label className="block text-sm font-semibold" htmlFor="promote-keywords">
          Track keywords
        </label>
        <p className="text-xs text-[var(--color-muted)]">
          One source per keyword, from the RSS Amplifier directory. Separate several with
          commas — a phrase like &ldquo;artificial intelligence&rdquo; counts as one keyword.
        </p>
        <input
          id="promote-keywords"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="bitcoin, blockchain, ethereum"
          className="input w-full text-sm"
        />
        <button type="submit" disabled={pending || !keywords.trim()} className="btn text-sm">
          {pending ? "Adding..." : "Add keywords"}
        </button>
      </form>

      <form onSubmit={submitFeed} className="space-y-2">
        <label className="block text-sm font-semibold" htmlFor="promote-feed">
          Add a feed
        </label>
        <p className="text-xs text-[var(--color-muted)]">
          Any RSS or Atom URL — your own blog, or a publication worth resharing.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            id="promote-feed"
            value={feedUrl}
            onChange={(e) => setFeedUrl(e.target.value)}
            placeholder="https://example.com/feed.xml"
            className="input min-w-0 flex-1 font-mono text-sm"
          />
          <select
            value={feedOwnership}
            onChange={(e) =>
              setFeedOwnership(e.target.value as "owned" | "partner" | "shared")
            }
            className="input text-sm"
            aria-label="Whose content this is"
          >
            <option value="owned">Our content</option>
            <option value="partner">Partner</option>
            <option value="shared">Industry</option>
          </select>
        </div>
        <button type="submit" disabled={pending || !feedUrl.trim()} className="btn text-sm">
          {pending ? "Checking..." : "Add feed"}
        </button>
      </form>
    </div>
  );
}
