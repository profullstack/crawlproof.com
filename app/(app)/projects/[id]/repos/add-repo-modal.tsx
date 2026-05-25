"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

interface AvailableRepo {
  full_name: string;
  installation_id: number;
  default_branch: string;
  private: boolean;
}

interface AddRepoModalProps {
  projectId: string;
  /** All repos the user has across every connected installation. */
  available: AvailableRepo[];
  /** repo_owner/repo_name strings already bound — hidden from the picker. */
  alreadyBound: string[];
}

export function AddRepoModal({
  projectId,
  available,
  alreadyBound,
}: AddRepoModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const boundSet = useMemo(() => new Set(alreadyBound), [alreadyBound]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return available
      .filter((r) => !boundSet.has(r.full_name))
      .filter((r) => !needle || r.full_name.toLowerCase().includes(needle));
  }, [available, boundSet, q]);

  async function bind(repo: AvailableRepo) {
    setError(null);
    setSubmitting(repo.full_name);
    const [owner, name] = repo.full_name.split("/");
    try {
      const res = await fetch(`/api/projects/${projectId}/repos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installation_id: repo.installation_id,
          owner,
          repo: name,
          default_branch: repo.default_branch,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Failed to add repo");
        return;
      }
      router.refresh();
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setError(null);
        }}
        className="btn btn-primary text-sm"
      >
        Add repo
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
              <h2 className="text-lg font-semibold">Add repo</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              >
                Close
              </button>
            </div>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              Pick a repo to bind to this project. Bound repos appear first
              in the Install Tracker and Apply Fix modals.
            </p>

            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Filter ${available.length} repos…`}
              className="mt-3 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            />

            <ul className="mt-3 max-h-72 overflow-y-auto divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
              {filtered.length === 0 ? (
                <li className="p-3 text-sm text-[var(--color-muted)]">
                  {available.length === 0
                    ? "No repos available — connect a GitHub installation first."
                    : "No repos match (or all matches are already bound)."}
                </li>
              ) : (
                filtered.slice(0, 50).map((r) => (
                  <li
                    key={r.full_name}
                    className="flex items-center justify-between gap-3 p-2"
                  >
                    <span className="truncate text-sm">{r.full_name}</span>
                    <button
                      type="button"
                      disabled={submitting !== null}
                      onClick={() => bind(r)}
                      className="btn btn-primary text-xs"
                    >
                      {submitting === r.full_name ? "Adding…" : "Add"}
                    </button>
                  </li>
                ))
              )}
            </ul>
            {filtered.length > 50 && (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Showing the first 50 of {filtered.length} matches — refine
                the filter to narrow further.
              </p>
            )}

            {error && (
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
