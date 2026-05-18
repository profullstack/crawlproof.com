"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setSitePaused } from "@/app/actions/linkExchange";

async function call(path: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(path, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok && json?.ok !== false, error: json?.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Wait up to ~90s for a new article to land in lx_article (created_at >
// `since`). Returns the article id or null on timeout. The dashboard
// generate button uses this to auto-redirect once the worker is done,
// so users don't sit on a "queued" message wondering what to do.
async function waitForNewArticle(
  since: Date,
  signal: AbortSignal,
  maxMs = 120_000,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (signal.aborted) return null;
    try {
      const res = await fetch(
        `/api/lx/articles/latest?since=${encodeURIComponent(since.toISOString())}`,
        { cache: "no-store", signal },
      );
      if (res.status === 200) {
        const json = (await res.json()) as { ok?: boolean; article?: { id: string } };
        if (json.ok && json.article?.id) return json.article.id;
      }
    } catch {
      // transient — keep polling
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

export function DashboardActions({
  paused,
  projectId,
}: {
  paused: boolean;
  projectId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(label: string, path: string, successMsg: string) {
    setBusy(label);
    setNotice(null);
    setError(null);
    call(path)
      .then((r) => {
        if (r.ok) {
          setNotice(successMsg);
          router.refresh();
        } else {
          setError(r.error ?? "Request failed.");
        }
      })
      .finally(() => setBusy(null));
  }

  async function generateArticleNow() {
    setBusy("article");
    setNotice("Generating… this takes ~30–60s.");
    setError(null);
    const since = new Date();
    const r = await call("/api/lx/articles/generate");
    if (!r.ok) {
      setBusy(null);
      setNotice(null);
      setError(r.error ?? "Could not queue article.");
      return;
    }
    const controller = new AbortController();
    const articleId = await waitForNewArticle(since, controller.signal);
    setBusy(null);
    if (articleId) {
      router.push(`/projects/${projectId}/autoblog/articles/${articleId}`);
    } else {
      setNotice(
        "Still generating. Check the 'Previews waiting on Publish' section in a moment.",
      );
      router.refresh();
    }
  }

  function togglePause() {
    setNotice(null);
    setError(null);
    startTransition(async () => {
      const r = await setSitePaused(!paused);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() =>
            run("sitemap", "/api/lx/sitemap/refresh", "Sitemap crawl queued.")
          }
        >
          {busy === "sitemap" ? "Crawling…" : "Refresh sitemap"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() =>
            run(
              "keywords",
              "/api/lx/keywords/refresh",
              "Keyword research queued.",
            )
          }
        >
          {busy === "keywords" ? "Generating…" : "Generate keywords"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={generateArticleNow}
        >
          {busy === "article" ? "Generating…" : "Generate article now"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={togglePause}
        >
          {pending ? "…" : paused ? "Resume" : "Pause"}
        </button>
      </div>
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
    </section>
  );
}

export function RetryButton({ articleId }: { articleId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setErr(null);
    const r = await call(`/api/lx/articles/${articleId}/retry`);
    setPending(false);
    if (r.ok) router.refresh();
    else setErr(r.error ?? "Retry failed.");
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="btn text-xs"
        disabled={pending}
        onClick={onClick}
      >
        {pending ? "Retrying…" : "Retry"}
      </button>
      {err && <span className="text-xs text-[var(--color-fail)]">{err}</span>}
    </div>
  );
}
