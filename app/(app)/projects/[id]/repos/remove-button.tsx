"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface RemoveButtonProps {
  projectId: string;
  repoId: string;
  repoFullName: string;
}

export function RemoveButton({ projectId, repoId, repoFullName }: RemoveButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove() {
    if (
      !window.confirm(
        `Unbind ${repoFullName} from this project? You can re-add it later.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      setError(null);
      const res = await fetch(`/api/projects/${projectId}/repos/${repoId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error || "Failed to remove");
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={remove}
        className="text-sm text-[var(--color-muted)] hover:text-red-600"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </>
  );
}
