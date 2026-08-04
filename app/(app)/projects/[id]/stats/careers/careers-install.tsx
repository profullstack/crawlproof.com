"use client";

// "Add a real /careers page to my repo" — the crawlable counterpart to the
// drop-in widget.
//
// Two steps on purpose. Detection is read-only and tells the user what we
// found before anything is written; only the second button opens a PR. People
// are reasonably wary of a button that commits to their repo sight unseen.

import { useState } from "react";
import type { RepoOption } from "@/lib/github/repo-options";

interface Detected {
  framework: "next-app" | "astro";
  dir: string;
  typescript: boolean;
  evidence: string;
}

interface InstallResult {
  status: "opened" | "noop";
  prUrl?: string;
  paths?: string[];
  detail: string;
}

const FRAMEWORK_LABEL: Record<Detected["framework"], string> = {
  "next-app": "Next.js (App Router)",
  astro: "Astro",
};

export function CareersInstall({
  projectId,
  repos,
  configured,
  enabled,
}: {
  projectId: string;
  repos: RepoOption[];
  configured: boolean;
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState(repos[0]?.full_name ?? "");
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<Detected | null | undefined>(undefined);
  const [result, setResult] = useState<InstallResult | null>(null);

  const selected = repos.find((r) => r.full_name === repo);

  async function call(mode: "detect" | "submit") {
    if (!selected) return;
    const [owner, name] = selected.full_name.split("/");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/github/install-careers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner,
          repo: name,
          installation_id: selected.installation_id,
          default_branch: selected.default_branch ?? undefined,
          root_path: rootPath.trim() || undefined,
          mode,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Something went wrong.");
        return;
      }
      if (mode === "detect") setDetected(payload.data.detected);
      else setResult(payload.data);
    } catch {
      setError("Could not reach GitHub. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!configured || repos.length === 0) return null;

  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Server-rendered careers page</h3>
          <p className="text-sm text-[var(--color-muted)]">
            The widget paints your board with JavaScript, which crawlers don&apos;t run.
            Open a PR that adds a real <code className="font-mono">/careers</code> route
            to your repo and the roles ship as HTML on your own domain.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="btn btn-secondary text-sm"
          disabled={!enabled}
        >
          {open ? "Close" : "Add to my repo"}
        </button>
      </div>

      {!enabled && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Turn the careers widget on first — the generated page reads from this project&apos;s feed.
        </p>
      )}

      {open && enabled && (
        <div className="mt-3 space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-[var(--color-muted)]">Repository</label>
            <select
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value);
                setDetected(undefined);
                setResult(null);
              }}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            >
              {repos.map((r) => (
                <option key={`${r.installation_id}:${r.full_name}`} value={r.full_name}>
                  {r.full_name}
                  {r.bound ? " (connected)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-[var(--color-muted)]">
              Site subdirectory (optional, for monorepos)
            </label>
            <input
              type="text"
              value={rootPath}
              onChange={(e) => {
                setRootPath(e.target.value);
                setDetected(undefined);
              }}
              placeholder="apps/web — leave blank for the repo root"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            />
          </div>

          {error && <p className="text-sm text-[var(--color-danger,#dc2626)]">{error}</p>}

          {detected === null && (
            <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-muted)]">
              No Next.js App Router or Astro site found there. Nothing was changed — your
              board still works through the tracker snippet, it just renders client-side.
            </p>
          )}

          {detected && (
            <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-muted)]">
              Found <strong>{FRAMEWORK_LABEL[detected.framework]}</strong> from{" "}
              <code className="font-mono">{detected.evidence}</code>. The PR will add the
              page under <code className="font-mono">{detected.dir}</code>.
            </p>
          )}

          {result && (
            <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
              {result.detail}{" "}
              {result.prUrl && (
                <a
                  href={result.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-[var(--color-foreground)]"
                >
                  Review the pull request
                </a>
              )}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => call("detect")}
              disabled={busy || !selected}
              className="btn btn-secondary text-sm"
            >
              {busy ? "Checking…" : "Check repo"}
            </button>
            <button
              type="button"
              onClick={() => call("submit")}
              disabled={busy || !selected || detected === null || !!result}
              className="btn btn-primary text-sm"
            >
              {busy ? "Working…" : "Open pull request"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
