"use client";

import { useMemo, useState } from "react";

interface Repo {
  full_name: string;
  default_branch: string;
  private: boolean;
  description: string | null;
  language: string | null;
  pushed_at: string | null;
  html_url: string;
}

interface ReposFilterProps {
  repos: Repo[];
}

export function ReposFilter({ repos }: ReposFilterProps) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter(
      (r) =>
        r.full_name.toLowerCase().includes(needle) ||
        (r.description ?? "").toLowerCase().includes(needle) ||
        (r.language ?? "").toLowerCase().includes(needle),
    );
  }, [q, repos]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Filter ${repos.length} repos…`}
          className="w-full max-w-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
        />
        <p className="text-xs text-[var(--color-muted)]">
          Showing {filtered.length} of {repos.length}
        </p>
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          No repos match this filter.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {filtered.map((r) => (
            <li
              key={r.full_name}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2"
            >
              <div className="min-w-0">
                <a
                  href={r.html_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium hover:underline"
                >
                  {r.full_name}
                </a>
                {r.description && (
                  <p className="text-xs text-[var(--color-muted)] line-clamp-1">
                    {r.description}
                  </p>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-2 text-xs text-[var(--color-muted)]">
                {r.private && (
                  <span className="rounded bg-[var(--color-border)] px-1.5 py-0.5">
                    private
                  </span>
                )}
                {r.language && <span>{r.language}</span>}
                <span>{r.default_branch}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
