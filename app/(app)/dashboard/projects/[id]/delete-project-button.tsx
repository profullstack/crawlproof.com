"use client";

import { deleteProject } from "@/app/actions/linkExchange";
import { DestructiveButton } from "@/components/destructive-button";

export function DeleteProjectButton({ projectId }: { projectId: string }) {
  return (
    <DestructiveButton
      label="Delete project"
      confirmLabel="Click again to delete project + everything in it"
      pendingLabel="Deleting project…"
      onConfirm={() => deleteProject({ projectId })}
      redirectTo="/dashboard"
    />
  );
}
