"use client";

import { useState } from "react";

interface InstallSnippetProps {
  projectId: string;
  projectName: string;
  projectUrl: string;
  siteUrl: string;
}

export function InstallSnippet({
  projectId,
  projectName,
  projectUrl,
  siteUrl,
}: InstallSnippetProps) {
  const htmlSnippet = `<script data-site="${projectId}" src="${siteUrl}/stats.js" async></script>`;
  const nextSnippet = `<Script data-site="${projectId}" src="${siteUrl}/stats.js" strategy="afterInteractive" />`;
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(htmlSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / iframes blocked from clipboard — fall back to noop.
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-[var(--color-muted)]">
        Paste this just before <code>&lt;/body&gt;</code> on every page you want
        tracked. We&apos;ll count AI-engine referrals (ChatGPT, Perplexity,
        Claude, Gemini …) and AI-crawler hits (GPTBot, ClaudeBot, …) and roll
        them up here.
      </p>
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs">
        <p>
          <span className="text-[var(--color-muted)]">Project:</span>{" "}
          <strong>{projectName}</strong>{" "}
          <span className="text-[var(--color-muted)]">({projectUrl})</span>
        </p>
        <p className="mt-1 font-mono">
          <span className="font-sans text-[var(--color-muted)]">Stats key:</span>{" "}
          {projectId}
        </p>
      </div>
      <pre className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
        <code>{htmlSnippet}</code>
      </pre>
      <details className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
        <summary className="cursor-pointer text-[var(--color-muted)]">
          Next.js App Router snippet
        </summary>
        <pre className="mt-2 overflow-x-auto font-mono">
          <code>{nextSnippet}</code>
        </pre>
      </details>
      <button type="button" onClick={copy} className="btn btn-secondary text-sm">
        {copied ? "Copied!" : "Copy HTML snippet"}
      </button>
    </div>
  );
}
