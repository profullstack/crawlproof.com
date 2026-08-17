"use client";

import { useMemo, useState } from "react";
import { BindButton } from "./bind-button";

interface Repo {
  full_name: string;
  default_branch: string;
  private: boolean;
  description: string | null;
  language: string | null;
  pushed_at: string | null;
  html_url: string;
}

interface Project {
  id: string;
  name: string;
}

interface Binding {
  id: string;
  project_id: string;
  installation_id: number;
  repo_owner: string;
  repo_name: string;
}

interface ReposFilterProps {
  repos: Repo[];
  installationId: number;
  projects: Project[];
  /** All bindings across this installation's repos — we slice per row. */
  bindings: Binding[];
}

export function ReposFilter({
  repos,
  installationId,
  projects,
  bindings,
}: ReposFilterProps) {
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

  // Group bindings by "owner/name" so per-row lookup is O(1).
  const bindingsByRepo = useMemo(() => {
    const map = new Map<string, Binding[]>();
    for (const b of bindings) {
      const k = `${b.repo_owner}/${b.repo_name}`;
      const cur = map.get(k);
      if (cur) cur.push(b);
      else map.set(k, [b]);
    }
    return map;
  }, [bindings]);

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
          {filtered.map((r) => {
            const [owner, name] = r.full_name.split("/");
            const repoBindings = bindingsByRepo.get(r.full_name) ?? [];
            return (
              <li
                key={r.full_name}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <a
                      href={r.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium hover:underline"
                    >
                      {r.full_name}
                    </a>
                    {r.private && (
                      <span className="rounded bg-[var(--color-border)] px-1.5 py-0.5 text-xs text-[var(--color-muted)]">
                        private
                      </span>
                    )}
                  </div>
                  {r.description && (
                    <p className="text-xs text-[var(--color-muted)] line-clamp-1">
                      {r.description}
                    </p>
                  )}
                  <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                    {r.language && <>{r.language} · </>}
                    {r.default_branch}
                  </p>
                </div>
                <div className="flex-shrink-0">
                  <BindButton
                    projects={projects}
                    bindings={repoBindings}
                    installationId={installationId}
                    owner={owner}
                    repo={name}
                    defaultBranch={r.default_branch}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
