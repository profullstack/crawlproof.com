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

export function DashboardActions({ paused }: { paused: boolean }) {
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
          onClick={() =>
            run(
              "article",
              "/api/lx/articles/generate",
              "Article generation queued.",
            )
          }
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
