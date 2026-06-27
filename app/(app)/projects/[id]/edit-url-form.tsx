"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateProjectUrl } from "@/app/actions/projects";

export function EditUrlForm({
  projectId,
  initialUrl,
  initialName,
}: {
  projectId: string;
  initialUrl: string;
  initialName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(initialUrl);
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(false);
    startTransition(async () => {
      const res = await updateProjectUrl({ projectId, url, name });
      if (!res.ok) {
        setError(res.error ?? "Could not update the URL.");
        return;
      }
      setUrl(res.url);
      setOk(true);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Edit URL
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Site URL
        </label>
        <input
          className="input mt-1"
          type="url"
          placeholder="https://example.com"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoFocus
        />
      </div>
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Project name
        </label>
        <input
          className="input mt-1"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {ok && <p className="text-sm text-[var(--color-pass)]">Saved.</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save URL"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setUrl(initialUrl);
            setName(initialName);
            setError(null);
            setOk(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
