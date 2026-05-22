"use client";

import { useState } from "react";

interface InstallSnippetProps {
  projectId: string;
  siteUrl: string;
}

export function InstallSnippet({ projectId, siteUrl }: InstallSnippetProps) {
  const snippet = `<script data-site="${projectId}" src="${siteUrl}/stats.js" async></script>`;
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
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
      <pre className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
        <code>{snippet}</code>
      </pre>
      <button type="button" onClick={copy} className="btn btn-secondary text-sm">
        {copied ? "Copied!" : "Copy snippet"}
      </button>
    </div>
  );
}
