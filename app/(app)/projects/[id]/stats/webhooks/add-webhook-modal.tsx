"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SecretReveal } from "./secret-reveal";

export function AddWebhookModal({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !secret) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, secret]);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          description: description || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Failed to add webhook");
        return;
      }
      setSecret(json.secret);
      setUrl("");
      setDescription("");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  function dismiss() {
    setSecret(null);
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-primary"
      >
        Add webhook
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => {
            if (!secret) setOpen(false);
          }}
        >
          <div
            className="card w-full max-w-lg p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold">Add webhook</h3>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Each tracker event for this project will be POSTed to this URL in
              real time, signed with HMAC-SHA256.
            </p>

            {secret ? (
              <div className="mt-4 space-y-3">
                <SecretReveal secret={secret} onDismiss={dismiss} />
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <label className="block">
                  <span className="text-xs text-[var(--color-muted)]">URL</span>
                  <input
                    type="url"
                    required
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com/webhooks/crawlproof"
                    className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-[var(--color-muted)]">
                    Description (optional)
                  </span>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="e.g. PostHog ingest"
                    className="mt-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
                  />
                </label>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded border border-[var(--color-border)] px-3 py-1 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!url || submitting}
                    onClick={submit}
                    className="btn btn-primary"
                  >
                    {submitting ? "Adding…" : "Add"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
