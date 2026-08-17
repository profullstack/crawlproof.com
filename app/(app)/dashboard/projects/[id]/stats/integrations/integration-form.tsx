"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  analyzeTrackerIntegration,
  deleteTrackerIntegration,
} from "@/app/actions/tracker-integrations";

export function IntegrationForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [snippet, setSnippet] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await analyzeTrackerIntegration({ projectId, name, snippet });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setName("");
      setSnippet("");
      setMessage("Integration analyzed.");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Add integration</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Paste a public tracker script, script URL, or inline SDK snippet.
          </p>
        </div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Analyzing..." : "Analyze"}
        </button>
      </div>

      <label className="block text-sm">
        <span className="font-medium">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
          placeholder="Anderro tracker"
        />
      </label>

      <label className="block text-sm">
        <span className="font-medium">Snippet</span>
        <textarea
          value={snippet}
          onChange={(event) => setSnippet(event.target.value)}
          className="mt-1 min-h-36 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs"
          placeholder={'<script src="https://track.example.com/a.js" data-key="pk_test_..." data-auto="true"></script>'}
          required
        />
      </label>

      {message && (
        <p
          className={`text-sm ${
            message === "Integration analyzed."
              ? "text-green-700"
              : "text-red-600"
          }`}
        >
          {message}
        </p>
      )}
    </form>
  );
}

export function DeleteIntegrationButton({
  projectId,
  integrationId,
}: {
  projectId: string;
  integrationId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove() {
    setError(null);
    startTransition(async () => {
      const result = await deleteTrackerIntegration({ projectId, integrationId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-1 text-right">
      <button
        type="button"
        className="btn btn-secondary text-xs"
        onClick={remove}
        disabled={pending}
      >
        {pending ? "Removing..." : "Remove"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
