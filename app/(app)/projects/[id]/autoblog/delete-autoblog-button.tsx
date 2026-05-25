"use client";

import { deleteAutoblog } from "@/app/actions/linkExchange";
import { DestructiveButton } from "@/components/destructive-button";

// Server action invocation needs to live inside a client component so
// the DestructiveButton's onConfirm prop can be a real function. The
// button itself is reusable; this thin wrapper just binds the action
// to a project id.
export function DeleteAutoblogButton({ projectId }: { projectId: string }) {
  return (
    <DestructiveButton
      label="Delete autoblog"
      confirmLabel="Click again to delete autoblog"
      pendingLabel="Deleting autoblog…"
      onConfirm={() => deleteAutoblog({ projectId })}
    />
  );
}
