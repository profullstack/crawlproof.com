"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Project {
  id: string;
  name: string;
}

interface Binding {
  id: string;
  project_id: string;
  installation_id: number;
}

interface BindButtonProps {
  /** All projects owned by the current user. */
  projects: Project[];
  /** Current bindings for THIS repo, keyed by project_id. */
  bindings: Binding[];
  installationId: number;
  owner: string;
  repo: string;
  defaultBranch: string;
}

export function BindButton({
  projects,
  bindings: initialBindings,
  installationId,
  owner,
  repo,
  defaultBranch,
}: BindButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [bindings, setBindings] = useState<Binding[]>(initialBindings);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const boundProjectIds = new Set(bindings.map((b) => b.project_id));

  async function toggle(projectId: string) {
    setError(null);
    const existing = bindings.find((b) => b.project_id === projectId);

    if (existing) {
      // Unbind.
      startTransition(async () => {
        const res = await fetch(
          `/api/projects/${projectId}/repos/${existing.id}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError(j.error || "Failed to unbind");
          return;
        }
        setBindings((bs) => bs.filter((b) => b.id !== existing.id));
        router.refresh();
      });
      return;
    }

    // Bind.
    startTransition(async () => {
      const res = await fetch(`/api/projects/${projectId}/repos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installation_id: installationId,
          owner,
          repo,
          default_branch: defaultBranch,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error || "Failed to bind");
        return;
      }
      const newBinding = j.data as Binding;
      setBindings((bs) => [...bs, newBinding]);
      router.refresh();
    });
  }

  if (projects.length === 0) {
    return (
      <span className="text-xs text-[var(--color-muted)]">
        Create a project first
      </span>
    );
  }

  const label =
    bindings.length === 0
      ? "Bind to project"
      : bindings.length === 1
        ? `Bound to ${
            projects.find((p) => p.id === bindings[0].project_id)?.name ?? "1 project"
          }`
        : `Bound to ${bindings.length} projects`;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn btn-secondary text-xs"
        disabled={pending}
      >
        {label} ▾
      </button>
      {open && (
        <>
          {/* Click-away catcher */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-transparent"
          />
          <div className="absolute right-0 z-50 mt-1 w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-2 shadow-lg">
            <p className="px-2 py-1 text-xs text-[var(--color-muted)]">
              Click a project to bind / unbind. Bound repos become
              the default in Apply Fix &amp; Install Tracker.
            </p>
            <ul className="mt-1 max-h-60 overflow-y-auto">
              {projects.map((p) => {
                const isBound = boundProjectIds.has(p.id);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => toggle(p.id)}
                      disabled={pending}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--color-bg)]"
                    >
                      <span className="truncate">{p.name}</span>
                      <span
                        className={
                          isBound
                            ? "text-green-600"
                            : "text-[var(--color-muted)]"
                        }
                      >
                        {isBound ? "✓ bound" : "+ bind"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {error && (
              <p className="mt-2 px-2 text-xs text-red-600">{error}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
