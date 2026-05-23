"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

interface Installation {
  installation_id: number;
  account_login: string;
}

interface Repo {
  full_name: string;
  installation_id: number;
  default_branch?: string | null;
}

interface AutoInstallProps {
  projectId: string;
  installations: Installation[];
  repos: Repo[];
  boundRepos: Repo[];
  notConfigured: boolean;
}

interface Candidate {
  path: string;
  score: number;
  sizeBytes?: number;
}

interface PreviewReady {
  status: "ready";
  path: string;
  snippet: string;
  before: string;
  after: string;
  addsImport: boolean;
}
interface PreviewAlready {
  status: "already_installed";
  path: string;
}
interface PreviewBad {
  status: "not_a_template";
  path: string;
  reason: string;
}
type Preview = PreviewReady | PreviewAlready | PreviewBad;

interface SubmitOk {
  status: "opened" | "noop";
  prUrl?: string;
  detail: string;
  path?: string;
}

type Step =
  | { kind: "pick-repo" }
  | { kind: "pick-path"; repo: Repo; candidates: Candidate[]; loading: boolean }
  | { kind: "preview"; repo: Repo; preview: Preview; path: string }
  | { kind: "done"; result: SubmitOk; repo: Repo };

export function AutoInstall({
  projectId,
  installations,
  repos,
  boundRepos,
  notConfigured,
}: AutoInstallProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "pick-repo" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [manualPath, setManualPath] = useState("");
  const [showAll, setShowAll] = useState(boundRepos.length === 0);

  // Reset state when the modal opens/closes.
  useEffect(() => {
    if (open) {
      setStep({ kind: "pick-repo" });
      setError(null);
      setQ("");
      setRootPath("");
      setManualPath("");
    }
  }, [open]);

  // ESC closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const source = showAll ? repos : boundRepos;
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return source;
    return source.filter((r) => r.full_name.toLowerCase().includes(needle));
  }, [q, source]);

  async function apiCall(repo: Repo, body: Record<string, unknown>) {
    const [owner, name] = repo.full_name.split("/");
    const res = await fetch(
      `/api/projects/${projectId}/github/install-tracker`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner,
          repo: name,
          installation_id: repo.installation_id,
          default_branch: repo.default_branch ?? undefined,
          ...body,
        }),
      },
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data;
  }

  async function startScan(repo: Repo) {
    setError(null);
    setBusy(true);
    setStep({ kind: "pick-path", repo, candidates: [], loading: true });
    try {
      const data = await apiCall(repo, {
        mode: "candidates",
        root_path: rootPath.trim() || undefined,
      });
      setStep({
        kind: "pick-path",
        repo,
        candidates: data.candidates ?? [],
        loading: false,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
      setStep({ kind: "pick-repo" });
    } finally {
      setBusy(false);
    }
  }

  async function previewPath(repo: Repo, path: string) {
    setError(null);
    setBusy(true);
    try {
      const preview: Preview = await apiCall(repo, {
        mode: "preview",
        target_path: path,
      });
      setStep({ kind: "preview", repo, preview, path });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitInstall(repo: Repo, path: string) {
    setError(null);
    setBusy(true);
    try {
      const result: SubmitOk = await apiCall(repo, {
        mode: "submit",
        target_path: path,
      });
      setStep({ kind: "done", result, repo });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  if (notConfigured) return null;

  return (
    <>
      <button
        type="button"
        className="btn btn-secondary text-sm"
        onClick={() => setOpen(true)}
      >
        Install via GitHub →
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">
                Install tracker via GitHub
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              >
                Close
              </button>
            </div>

            {/* STEP 1: pick repo */}
            {step.kind === "pick-repo" && (
              <>
                {installations.length === 0 ? (
                  <p className="mt-3 text-sm text-[var(--color-muted)]">
                    You haven&apos;t connected a GitHub installation yet.{" "}
                    <a href="/settings/integrations/github" className="underline">
                      Connect on the GitHub settings page
                    </a>
                    .
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-sm text-[var(--color-muted)]">
                      Pick the repo for this site. You&apos;ll review the
                      target file before any PR is opened.
                    </p>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <input
                        type="text"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder={`Filter ${source.length} repos…`}
                        className="w-full max-w-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                      />
                      {boundRepos.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowAll((v) => !v)}
                          className="text-xs text-[var(--color-muted)] underline hover:text-[var(--color-foreground)]"
                        >
                          {showAll
                            ? `Show ${boundRepos.length} bound repo${boundRepos.length === 1 ? "" : "s"}`
                            : `Browse all ${repos.length} repos`}
                        </button>
                      )}
                    </div>

                    <ul className="mt-3 max-h-72 overflow-y-auto divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
                      {filtered.slice(0, 50).map((r) => (
                        <li
                          key={r.full_name}
                          className="flex items-center justify-between gap-3 p-2"
                        >
                          <span className="truncate text-sm">{r.full_name}</span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => startScan(r)}
                            className="btn btn-primary text-xs"
                          >
                            Use this repo
                          </button>
                        </li>
                      ))}
                    </ul>

                    <div className="mt-3 space-y-1">
                      <label className="text-xs text-[var(--color-muted)]">
                        Web app subdirectory (optional, for monorepos)
                      </label>
                      <input
                        type="text"
                        value={rootPath}
                        onChange={(e) => setRootPath(e.target.value)}
                        placeholder="apps/web — leave blank to scan whole repo"
                        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                      />
                    </div>
                  </>
                )}
              </>
            )}

            {/* STEP 2: pick path */}
            {step.kind === "pick-path" && (
              <>
                <p className="mt-2 text-sm text-[var(--color-muted)]">
                  Repo: <strong>{step.repo.full_name}</strong>
                  {rootPath && <> · root <code>{rootPath}</code></>}
                </p>

                {step.loading ? (
                  <p className="mt-4 text-sm text-[var(--color-muted)]">
                    Scanning repo for layout files…
                  </p>
                ) : step.candidates.length === 0 ? (
                  <p className="mt-4 text-sm">
                    No candidate files found. Enter a file path manually
                    below, or close and try a different repo.
                  </p>
                ) : (
                  <>
                    <p className="mt-4 text-sm font-medium">
                      Candidates (best match first):
                    </p>
                    <ul className="mt-2 max-h-60 overflow-y-auto divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
                      {step.candidates.map((c) => (
                        <li
                          key={c.path}
                          className="flex items-center justify-between gap-3 p-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-mono">{c.path}</p>
                            <p className="text-xs text-[var(--color-muted)]">
                              score {c.score.toFixed(0)}
                              {c.sizeBytes != null && ` · ${c.sizeBytes}b`}
                            </p>
                          </div>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => previewPath(step.repo, c.path)}
                            className="btn btn-primary text-xs"
                          >
                            Use this file
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                <div className="mt-4 space-y-1">
                  <label className="text-xs text-[var(--color-muted)]">
                    Or enter a path manually:
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={manualPath}
                      onChange={(e) => setManualPath(e.target.value)}
                      placeholder="apps/web/src/app/layout.tsx"
                      className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm font-mono"
                    />
                    <button
                      type="button"
                      disabled={busy || !manualPath.trim()}
                      onClick={() => previewPath(step.repo, manualPath.trim())}
                      className="btn btn-secondary text-sm"
                    >
                      Preview
                    </button>
                  </div>
                </div>

                <div className="mt-4 flex justify-between">
                  <button
                    type="button"
                    onClick={() => setStep({ kind: "pick-repo" })}
                    className="text-xs text-[var(--color-muted)] underline"
                  >
                    ← back
                  </button>
                </div>
              </>
            )}

            {/* STEP 3: preview */}
            {step.kind === "preview" && (
              <>
                <p className="mt-2 text-sm text-[var(--color-muted)]">
                  Repo: <strong>{step.repo.full_name}</strong> · path{" "}
                  <code className="font-mono">{step.path}</code>
                </p>

                {step.preview.status === "already_installed" && (
                  <div className="mt-4 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-sm">
                    Tracker already installed at{" "}
                    <code>{step.preview.path}</code>. Nothing to do.
                  </div>
                )}
                {step.preview.status === "not_a_template" && (
                  <div className="mt-4 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
                    {step.preview.reason} Pick a different file or close and
                    try a different repo.
                  </div>
                )}
                {step.preview.status === "ready" && (
                  <>
                    <p className="mt-4 text-sm font-medium">
                      The PR will add this line before <code>&lt;/body&gt;</code>:
                    </p>
                    <pre className="mt-2 overflow-x-auto rounded border border-[var(--color-border)] bg-[#0b0d10] p-3 font-mono text-xs">
                      {step.preview.snippet}
                    </pre>
                    {step.preview.addsImport && (
                      <p className="mt-2 text-xs text-[var(--color-muted)]">
                        Also adds{" "}
                        <code>import Script from &quot;next/script&quot;;</code>{" "}
                        to the top of the file.
                      </p>
                    )}
                  </>
                )}

                {error && (
                  <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700">
                    {error}
                  </div>
                )}

                <div className="mt-4 flex justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setStep({ kind: "pick-repo" })}
                    className="text-xs text-[var(--color-muted)] underline"
                  >
                    ← back
                  </button>
                  {step.preview.status === "ready" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => submitInstall(step.repo, step.path)}
                      className="btn btn-primary text-sm"
                    >
                      {busy ? "Opening PR…" : "Open PR"}
                    </button>
                  )}
                </div>
              </>
            )}

            {/* STEP 4: done */}
            {step.kind === "done" && (
              <div className="mt-4">
                <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
                  <p className="font-medium">
                    {step.result.status === "opened"
                      ? "PR opened"
                      : "Already installed"}
                  </p>
                  <p className="mt-1 text-[var(--color-muted)]">
                    {step.result.detail}
                  </p>
                  {step.result.prUrl && (
                    <a
                      href={step.result.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block underline"
                    >
                      Open PR →
                    </a>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="btn btn-secondary mt-4 text-sm"
                >
                  Close
                </button>
              </div>
            )}

            {error && step.kind !== "preview" && (
              <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700">
                {error}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
