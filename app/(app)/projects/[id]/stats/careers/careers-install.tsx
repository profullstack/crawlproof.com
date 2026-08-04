"use client";

// "Add a real /careers page to my repo" — the crawlable counterpart to the
// drop-in widget.
//
// Two steps on purpose. Scanning is read-only and shows what we found before
// anything is written; only the second button opens a PR. People are reasonably
// wary of a button that commits to their repo sight unseen.
//
// The scan lists every place the route could go, ranked, the way the stats
// tracker installer does. Asking someone to type their own monorepo path and
// answering a miss with "not supported" was the wrong shape: in a monorepo the
// site is rarely at the root, and a wrong guess looked like a missing feature.

import { useState } from "react";
import type { RepoOption } from "@/lib/github/repo-options";

interface Detected {
  framework: "next-app" | "astro";
  dir: string;
  typescript: boolean;
  evidence: string;
}

interface Candidate extends Detected {
  score: number;
  existingPath?: string;
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
  const [candidates, setCandidates] = useState<Candidate[] | undefined>(undefined);
  const [truncated, setTruncated] = useState(false);
  const [chosenDir, setChosenDir] = useState("");
  const [manualDir, setManualDir] = useState("");
  const [result, setResult] = useState<InstallResult | null>(null);

  const selected = repos.find((r) => r.full_name === repo);
  const chosen = candidates?.find((c) => c.dir === chosenDir);
  const targetDir = chosenDir || manualDir.trim();

  /** Any change to repo or root invalidates a scan taken against the old one. */
  function resetScan() {
    setCandidates(undefined);
    setChosenDir("");
    setResult(null);
    setError(null);
  }

  async function call(mode: "candidates" | "submit") {
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
          target_dir: mode === "submit" ? targetDir || undefined : undefined,
          mode,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload?.error ?? "Something went wrong.");
        return;
      }
      if (mode === "candidates") {
        const found: Candidate[] = payload.data.candidates ?? [];
        setCandidates(found);
        setTruncated(Boolean(payload.data.truncated));
        // Preselect the best match; it is right in the common case and the
        // list is there when it isn't.
        setChosenDir(found[0]?.dir ?? "");
      } else {
        setResult(payload.data);
      }
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
                resetScan();
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
              Limit the scan to a subdirectory (optional)
            </label>
            <input
              type="text"
              value={rootPath}
              onChange={(e) => {
                setRootPath(e.target.value);
                resetScan();
              }}
              placeholder="apps/web — leave blank to scan the whole repo"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            />
          </div>

          {error && <p className="text-sm text-[var(--color-danger,#dc2626)]">{error}</p>}

          {candidates?.length === 0 && (
            <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-muted)]">
              No Next.js App Router or Astro site found in this repo. Nothing was changed —
              your board still works through the tracker snippet, it just renders
              client-side. If the site lives somewhere unusual, enter the directory holding{" "}
              <code className="font-mono">layout.tsx</code> below.
            </p>
          )}

          {!!candidates?.length && (
            <div className="space-y-1">
              <p className="text-xs text-[var(--color-muted)]">
                {candidates.length === 1
                  ? "Found one place the page can go:"
                  : `Found ${candidates.length} places the page can go, best match first:`}
              </p>
              <ul className="max-h-60 divide-y divide-[var(--color-border)] overflow-y-auto rounded-md border border-[var(--color-border)]">
                {candidates.map((c) => (
                  <li key={c.dir}>
                    <label className="flex cursor-pointer items-start gap-3 p-2">
                      <input
                        type="radio"
                        name="careers-dir"
                        className="mt-1"
                        checked={chosenDir === c.dir}
                        onChange={() => {
                          setChosenDir(c.dir);
                          setManualDir("");
                          setResult(null);
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-sm">{c.dir}</span>
                        <span className="block text-xs text-[var(--color-muted)]">
                          {FRAMEWORK_LABEL[c.framework]} · from{" "}
                          <code className="font-mono">{c.evidence}</code>
                        </span>
                        {c.existingPath && (
                          <span className="block text-xs text-[var(--color-muted)]">
                            Already has <code className="font-mono">{c.existingPath}</code> —
                            CrawlProof will leave it alone.
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {truncated && (
                <p className="text-xs text-[var(--color-muted)]">
                  This repo is large enough that GitHub truncated the file listing, so the
                  scan may have missed a location. Enter it below if it isn&apos;t here.
                </p>
              )}
            </div>
          )}

          {candidates !== undefined && (
            <div className="space-y-1">
              <label className="text-xs text-[var(--color-muted)]">
                Or enter the route directory yourself
              </label>
              <input
                type="text"
                value={manualDir}
                onChange={(e) => {
                  setManualDir(e.target.value);
                  setChosenDir("");
                  setResult(null);
                }}
                placeholder="apps/web/src/app — the directory containing layout.tsx"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
              />
            </div>
          )}

          {chosen && (
            <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-muted)]">
              The PR will add the page under <code className="font-mono">{chosen.dir}</code>{" "}
              as {FRAMEWORK_LABEL[chosen.framework]}.
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
              onClick={() => call("candidates")}
              disabled={busy || !selected}
              className="btn btn-secondary text-sm"
            >
              {busy ? "Scanning…" : candidates === undefined ? "Scan repo" : "Rescan"}
            </button>
            <button
              type="button"
              onClick={() => call("submit")}
              disabled={busy || !selected || !targetDir || !!result}
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
