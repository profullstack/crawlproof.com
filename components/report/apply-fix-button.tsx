"use client";

import { useEffect, useMemo, useState } from "react";

interface Repo {
  full_name: string;
  installation_id: number;
}

interface ApplyFixButtonProps {
  projectId: string;
  auditId: string;
  findingKey: string;
  findingTitle: string;
  repos: Repo[];
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
}: ApplyFixButtonProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [result, setResult] = useState<FixResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter((r) => r.full_name.toLowerCase().includes(needle));
  }, [q, repos]);

  async function run(repo: Repo) {
    setError(null);
    setSubmitting(repo.full_name);
    setResult(null);
    const [owner, name] = repo.full_name.split("/");
    try {
      const res = await fetch(
        `/api/projects/${projectId}/github/apply-fix`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner,
            repo: name,
            installation_id: repo.installation_id,
            audit_id: auditId,
            finding_key: findingKey,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Failed to open fix PR");
        return;
      }
      setResult(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
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
        }}
      >
        Fix via PR
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-base font-semibold">
                Fix via PR — <code className="font-mono text-sm">{findingKey}</code>
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              >
                Close
              </button>
            </div>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              {findingTitle}
            </p>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Costs <strong>1 credit</strong>. Claude reads the relevant
              files, proposes a minimal patch, and opens a PR. We refund
              the credit if the run fails.
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
                <input
                  type="text"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={`Filter ${repos.length} repos…`}
                  className="mt-3 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                />
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
                        {submitting === r.full_name ? "Working…" : "Use 1 credit"}
                      </button>
                    </li>
                  ))}
                </ul>

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
