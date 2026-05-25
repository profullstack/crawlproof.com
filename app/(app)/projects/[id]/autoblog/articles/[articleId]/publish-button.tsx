"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { publishArticle } from "@/app/actions/linkExchange";

export function PublishButton({ articleId }: { articleId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function onClick() {
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await publishArticle({ articleId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNotice(
        "Webhook delivery enqueued. The article's status updates to 'published' once your receiver returns 2xx.",
      );
      // Refresh so the page re-fetches and the badge transitions to
      // 'publishing' / 'published'.
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        className="btn btn-primary"
        onClick={onClick}
        disabled={pending}
      >
        {pending ? "Publishing…" : "Publish this article"}
      </button>
      {error && <span className="text-sm text-[var(--color-fail)]">{error}</span>}
      {notice && <span className="text-sm text-[var(--color-pass)]">{notice}</span>}
    </div>
  );
}
