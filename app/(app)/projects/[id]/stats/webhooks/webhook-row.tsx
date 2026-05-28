"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SecretReveal } from "./secret-reveal";

export interface WebhookRowData {
  id: string;
  url: string;
  description: string | null;
  enabled: boolean;
  last_delivery_at: string | null;
  last_response_code: number | null;
  last_error: string | null;
  created_at: string;
}

function formatLastDelivery(row: WebhookRowData) {
  if (!row.last_delivery_at) return "Never delivered";
  const when = new Date(row.last_delivery_at).toLocaleString();
  if (row.last_response_code && row.last_response_code >= 200 && row.last_response_code < 300) {
    return `Last delivery: ${when} · ${row.last_response_code}`;
  }
  const code = row.last_response_code ? `HTTP ${row.last_response_code}` : "network error";
  return `Last delivery: ${when} · ${code}${row.last_error ? ` — ${row.last_error}` : ""}`;
}

export function WebhookRow({
  projectId,
  row,
}: {
  projectId: string;
  row: WebhookRowData;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftUrl, setDraftUrl] = useState(row.url);
  const [draftDescription, setDraftDescription] = useState(row.description ?? "");
  const [testResult, setTestResult] = useState<string | null>(null);

  function patch(body: Record<string, unknown>, after?: (json: any) => void) {
    startTransition(async () => {
      setError(null);
      const res = await fetch(`/api/projects/${projectId}/webhooks/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Failed");
        return;
      }
      after?.(json);
      router.refresh();
    });
  }

  function toggleEnabled() {
    patch({ enabled: !row.enabled });
  }

  function saveEdit() {
    patch(
      { url: draftUrl, description: draftDescription || null },
      () => setEditing(false),
    );
  }

  function rotate() {
    if (!window.confirm("Rotate the webhook secret? Receivers using the old secret will start failing until updated.")) {
      return;
    }
    patch({ rotate_secret: true }, (json) => {
      if (json.secret) setRotatedSecret(json.secret);
    });
  }

  function remove() {
    if (!window.confirm(`Delete webhook ${row.url}? This can't be undone.`)) {
      return;
    }
    startTransition(async () => {
      setError(null);
      const res = await fetch(`/api/projects/${projectId}/webhooks/${row.id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        const json = await res.json().catch(() => ({}));
        setError(json.error || "Failed to delete");
        return;
      }
      router.refresh();
    });
  }

  function sendTest() {
    setTestResult(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/projects/${projectId}/webhooks/${row.id}/test`,
        { method: "POST" },
      );
      const json = await res.json().catch(() => ({}));
      if (json.ok) {
        setTestResult(`OK (${json.status} in ${json.ms}ms)`);
      } else {
        setTestResult(
          `Failed: ${json.error ?? `HTTP ${json.status ?? "?"}`}${json.ms ? ` in ${json.ms}ms` : ""}`,
        );
      }
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <input
                type="url"
                value={draftUrl}
                onChange={(e) => setDraftUrl(e.target.value)}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
              />
              <input
                type="text"
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                placeholder="Description (optional)"
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
              />
            </div>
          ) : (
            <>
              <p className="truncate text-sm font-medium">{row.url}</p>
              {row.description && (
                <p className="text-xs text-[var(--color-muted)]">{row.description}</p>
              )}
              <p className="text-xs text-[var(--color-muted)]">
                {formatLastDelivery(row)}
              </p>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={row.enabled}
              disabled={pending}
              onChange={toggleEnabled}
            />
            Enabled
          </label>
          {editing ? (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={saveEdit}
                className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
              >
                Save
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setEditing(false);
                  setDraftUrl(row.url);
                  setDraftDescription(row.description ?? "");
                }}
                className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={pending}
                onClick={sendTest}
                className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
              >
                {pending ? "…" : "Test"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setEditing(true)}
                className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
              >
                Edit
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={rotate}
                className="rounded border border-[var(--color-border)] px-2 py-1 text-xs"
              >
                Rotate secret
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={remove}
                className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-red-600"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {testResult && (
        <p
          className={`text-xs ${
            testResult.startsWith("OK") ? "text-green-600" : "text-red-600"
          }`}
        >
          {testResult}
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {rotatedSecret && (
        <SecretReveal
          secret={rotatedSecret}
          onDismiss={() => setRotatedSecret(null)}
        />
      )}
    </li>
  );
}
