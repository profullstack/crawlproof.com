"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

interface Repo {
  full_name: string;
  installation_id: number;
}

interface ApplyFixButtonProps {
  projectId: string;
  auditId: string;
  findingKey: string;
  findingTitle: string;
  /** Every repo across the user's installations. */
  repos: Repo[];
  /** Subset already bound to the project. Pre-selected when present. */
  boundRepos: Repo[];
}

interface FixResult {
  status: "opened" | "noop";
  prUrl?: string;
  detail: string;
  changedPaths?: string[];
}

export function ApplyFixButton({
  projectId,
  auditId,
  findingKey,
  findingTitle,
  repos,
  boundRepos,
}: ApplyFixButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [result, setResult] = useState<FixResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(boundRepos.length === 0);
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  function closeStream() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    return () => closeStream();
  }, []);

  function closeModal() {
    closeStream();
    setOpen(false);
    setSubmitting(null);
  }

  function addStatus(message: string) {
    setStatusLog((prev) => [...prev, message].slice(-80));
  }

  const source = showAll ? repos : boundRepos;
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return source;
    return source.filter((r) => r.full_name.toLowerCase().includes(needle));
  }, [q, source]);

  async function run(repo: Repo) {
    setError(null);
    setSubmitting(repo.full_name);
    setResult(null);
    setStatusLog([]);
    closeStream();
    const [owner, name] = repo.full_name.split("/");
    try {
      const params = new URLSearchParams({
        owner,
        repo: name,
        installation_id: String(repo.installation_id),
        audit_id: auditId,
        finding_key: findingKey,
      });
      const es = new EventSource(
        `/api/projects/${projectId}/github/apply-fix?${params.toString()}`,
      );
      eventSourceRef.current = es;

      es.addEventListener("status", (event) => {
        try {
          const data = JSON.parse(event.data) as { message?: string };
          if (data.message) addStatus(data.message);
        } catch {
          addStatus(event.data);
        }
      });

      es.addEventListener("done", (event) => {
        closeStream();
        setSubmitting(null);
        try {
          setResult(JSON.parse(event.data) as FixResult);
          router.refresh();
        } catch {
          setError("Fix finished, but the response could not be read.");
        }
      });

      es.addEventListener("failed", (event) => {
        closeStream();
        setSubmitting(null);
        try {
          const data = JSON.parse(event.data) as { message?: string };
          setError(data.message || "Failed to open fix PR");
        } catch {
          setError("Failed to open fix PR");
        }
      });

      es.onerror = () => {
        closeStream();
        setSubmitting(null);
        setError("Lost connection to the fix worker. The run may still finish server-side.");
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setSubmitting(null);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-secondary text-xs"
        onClick={() => {
          setOpen(true);
          setResult(null);
          setError(null);
          setStatusLog([]);
        }}
      >
        Fix via PR
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 sm:items-center"
          onClick={closeModal}
        >
          <div
            className="w-full max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-base font-semibold">
                Fix via PR — <code className="font-mono text-sm">{findingKey}</code>
              </h2>
              <button
                type="button"
                onClick={closeModal}
                className="text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              >
                Close
              </button>
            </div>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              {findingTitle}
            </p>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Costs <strong>20 credits (~$1)</strong>. Claude reads the relevant
              files, proposes a minimal patch, and opens a PR. We refund
              the credits if the run fails.
            </p>

            {repos.length === 0 ? (
              <p className="mt-4 text-sm">
                You haven&apos;t connected a GitHub installation yet.{" "}
                <a
                  href="/settings/integrations/github"
                  className="underline"
                >
                  Connect on the GitHub settings page
                </a>
                .
              </p>
            ) : (
              <>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <input
                    type="text"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={`Filter ${source.length} repo${source.length === 1 ? "" : "s"}…`}
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
                <ul className="mt-3 max-h-64 overflow-y-auto divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
                  {filtered.slice(0, 50).map((r) => (
                    <li
                      key={r.full_name}
                      className="flex items-center justify-between gap-3 p-2"
                    >
                      <span className="truncate text-sm">{r.full_name}</span>
                      <button
                        type="button"
                        disabled={submitting !== null}
                        onClick={() => run(r)}
                        className="btn btn-primary text-xs"
                      >
                        {submitting === r.full_name ? "Working…" : "Use 20 credits"}
                      </button>
                    </li>
                  ))}
                </ul>

                {(submitting || statusLog.length > 0) && (
                  <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                    <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium">Status log</span>
                      {submitting && (
                        <span className="text-[var(--color-muted)]">
                          Working…
                        </span>
                      )}
                    </div>
                    <div className="max-h-44 space-y-1 overflow-y-auto font-mono text-xs leading-relaxed text-[var(--color-muted)]">
                      {statusLog.length === 0 ? (
                        <div>Opening stream…</div>
                      ) : (
                        statusLog.map((line, i) => (
                          <div key={`${i}-${line}`}>
                            <span className="select-none text-[var(--color-muted)]/70">
                              {String(i + 1).padStart(2, "0")}{" "}
                            </span>
                            {line}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {error && (
                  <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700">
                    {error}
                  </div>
                )}
                {result && (
                  <div className="mt-4 rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
                    <p className="font-medium">
                      {result.status === "opened" ? "PR opened" : "No changes proposed"}
                    </p>
                    <p className="mt-1 text-[var(--color-muted)]">
                      {result.detail}
                    </p>
                    {result.prUrl && (
                      <a
                        href={result.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block underline"
                      >
                        Open PR →
                      </a>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
