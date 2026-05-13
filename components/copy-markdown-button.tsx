"use client";

import { useState } from "react";

// Fetches a Markdown endpoint and copies the response body to the
// clipboard. Used on the scan-run page to grab the consolidated
// "executive summary + per-engine reports" document for pasting into
// another LLM.
export function CopyMarkdownButton({
  href,
  label = "Copy Markdown",
}: {
  href: string;
  label?: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "copied" | "error">(
    "idle",
  );

  async function onClick() {
    setState("loading");
    try {
      const res = await fetch(href, { cache: "no-store" });
      if (!res.ok) {
        setState("error");
        return;
      }
      const md = await res.text();
      await navigator.clipboard.writeText(md);
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 3000);
    }
  }

  return (
    <button
      className="btn"
      onClick={onClick}
      disabled={state === "loading"}
      title="Copy the full report as Markdown — paste into another LLM"
    >
      {state === "loading"
        ? "Copying…"
        : state === "copied"
          ? "Copied ✓"
          : state === "error"
            ? "Failed — retry"
            : label}
    </button>
  );
}
