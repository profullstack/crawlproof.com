"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setSitePaused } from "@/app/actions/linkExchange";

async function call(
  path: string,
): Promise<{ ok: boolean; error?: string; action?: string; message?: string }> {
  try {
    const res = await fetch(path, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    return {
      ok: res.ok && json?.ok !== false,
      error: json?.error,
      action: json?.action,
      message: json?.message,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function DashboardActions({
  paused,
  projectId,
  queuedCount,
  failedCount,
}: {
  paused: boolean;
  projectId: string;
  queuedCount: number;
  failedCount: number;
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
    setNotice(null);
    setError(null);
    const r = await call(
      `/api/lx/articles/generate?projectId=${encodeURIComponent(projectId)}`,
    );
    setBusy(null);
    if (!r.ok) {
      setError(r.error ?? "Could not queue article.");
      return;
    }
    // Don't poll from the client — the amber Previews section above
    // owns the in-flight state via the page's lx_keyword query, and
    // AutoblogAutoRefresh re-fetches every few seconds while anything
    // is generating. We just kick the first refresh so the worker's
    // 'generating' claim shows up immediately instead of after the
    // next interval tick.
    setNotice(
      r.action === "keyword_research"
        ? (r.message ??
          "No queued keywords were available, so keyword research was started. Try Generate article now again after research finishes.")
        : "Queued — the preview will appear in the section above when it's ready (1–3 minutes).",
    );
    router.refresh();
  }

  async function regenerateQueue() {
    const total = queuedCount + failedCount;
    const summary =
      total > 0
        ? `Delete ${queuedCount} queued + ${failedCount} failed keyword${total === 1 ? "" : "s"} and spend ~$0.22 on fresh research?`
        : "Re-run keyword research with your current niche/audiences?";
    if (!window.confirm(`${summary}\n\nPublished keywords stay deduped so we don't regenerate the same articles.`)) {
      return;
    }
    setBusy("regenerate");
    setNotice(null);
    setError(null);
    const r = await call(
      `/api/lx/keywords/regenerate?projectId=${encodeURIComponent(projectId)}`,
    );
    setBusy(null);
    if (r.ok) {
      setNotice("Queue cleared — fresh research queued.");
      router.refresh();
    } else {
      setError(r.error ?? "Could not regenerate queue.");
    }
  }

  function togglePause() {
    setNotice(null);
    setError(null);
    startTransition(async () => {
      const r = await setSitePaused(!paused, projectId);
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
            run(
              "sitemap",
              `/api/lx/sitemap/refresh?projectId=${encodeURIComponent(projectId)}`,
              "Sitemap crawl queued.",
            )
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
              `/api/lx/keywords/refresh?projectId=${encodeURIComponent(projectId)}`,
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
          onClick={regenerateQueue}
          title="Clear queued + failed keywords and re-run research with your current niche/audiences/seeds."
        >
          {busy === "regenerate" ? "Regenerating…" : "Regenerate queue"}
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

export function RepublishButton({ articleId }: { articleId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onClick() {
    if (
      !window.confirm(
        "Re-fire delivery for this published article? Useful if the receiver's blog row was deleted or you want to refresh the live copy. The receiver upserts on (source, source_id) so this replaces rather than duplicates.",
      )
    )
      return;
    setPending(true);
    setErr(null);
    const r = await call(`/api/lx/articles/${articleId}/republish`);
    setPending(false);
    if (r.ok) router.refresh();
    else setErr(r.error ?? "Republish failed.");
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="btn text-xs"
        disabled={pending}
        onClick={onClick}
        title="Re-deliver the webhook for this article"
      >
        {pending ? "Republishing…" : "Republish"}
      </button>
      {err && <span className="text-xs text-[var(--color-fail)]">{err}</span>}
    </div>
  );
}
