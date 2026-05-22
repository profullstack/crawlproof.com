"use client";

import { useRef, useState } from "react";

export function ShareBanner({
  url,
  reportTitle,
  scoreLabel,
}: {
  url: string;
  reportTitle?: string;
  scoreLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      inputRef.current?.select();
      document.execCommand?.("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const tweetText = encodeURIComponent(
    reportTitle
      ? `My CrawlProof AEO audit${scoreLabel ? ` (${scoreLabel})` : ""}: ${reportTitle}`
      : `My CrawlProof AEO audit${scoreLabel ? ` (${scoreLabel})` : ""}`,
  );
  const xHref = `https://x.com/intent/tweet?text=${tweetText}&url=${encodeURIComponent(url)}`;
  const liHref = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;

  return (
    <div className="card mb-6 border-l-4 border-l-[var(--color-accent)] p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-accent)]">
            Public share link
          </p>
          <input
            ref={inputRef}
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.currentTarget.select()}
            className="mt-1 w-full bg-transparent font-mono text-sm text-[var(--color-fg)] outline-none"
            aria-label="Public share link"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <button
            type="button"
            onClick={copy}
            className="btn btn-primary whitespace-nowrap px-3 py-2 text-sm"
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
          <a
            href={xHref}
            target="_blank"
            rel="noreferrer"
            className="btn whitespace-nowrap px-3 py-2 text-sm"
            aria-label="Share on X"
            title="Share on X"
          >
            Post on X
          </a>
          <a
            href={liHref}
            target="_blank"
            rel="noreferrer"
            className="btn whitespace-nowrap px-3 py-2 text-sm"
            aria-label="Share on LinkedIn"
            title="Share on LinkedIn"
          >
            LinkedIn
          </a>
        </div>
      </div>
    </div>
  );
}
