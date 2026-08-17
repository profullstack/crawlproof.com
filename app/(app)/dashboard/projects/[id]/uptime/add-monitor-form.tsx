"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createMonitor, type CreateMonitorInput } from "@/app/actions/monitors";

type MonitorType = "http" | "keyword" | "ssl" | "tcp";

const TYPE_HINT: Record<MonitorType, string> = {
  http: "URL to request — up when it returns 2xx/3xx.",
  keyword: "URL + a keyword that must appear (or not) in the response body.",
  ssl: "Host — alerts when the TLS cert nears expiry.",
  tcp: "host:port — up when the port accepts a connection.",
};

export function AddMonitorForm({
  projectId,
  defaultName = "",
  defaultTarget = "",
  defaultEmail = "",
}: {
  projectId: string;
  defaultName?: string;
  defaultTarget?: string;
  defaultEmail?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<MonitorType>("http");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(formData: FormData) {
    setError(null);
    const input: CreateMonitorInput = {
      projectId,
      type,
      name: String(formData.get("name") ?? ""),
      target: String(formData.get("target") ?? ""),
      intervalS: Number(formData.get("intervalS") ?? 60),
      alertEmail: String(formData.get("alertEmail") ?? ""),
      keyword: String(formData.get("keyword") ?? ""),
      match: (String(formData.get("match") ?? "present") as "present" | "absent"),
    };
    start(async () => {
      const res = await createMonitor(input);
      if (!res.ok) {
        setError(res.error ?? "Failed.");
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-accent-fg)]"
      >
        Add monitor
      </button>
    );
  }

  return (
    <form
      action={submit}
      className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4"
    >
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--color-muted)]">Type</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as MonitorType)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          >
            <option value="http">HTTP(S)</option>
            <option value="keyword">Keyword</option>
            <option value="ssl">SSL expiry</option>
            <option value="tcp">TCP port</option>
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs">
          <span className="text-[var(--color-muted)]">Name</span>
          <input
            name="name"
            required
            defaultValue={defaultName}
            placeholder="My site"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[var(--color-muted)]">Target</span>
        <input
          name="target"
          required
          defaultValue={defaultTarget}
          placeholder={type === "tcp" ? "db.example.com:5432" : type === "ssl" ? "example.com" : "https://example.com"}
          className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm font-mono"
        />
        <span className="text-[var(--color-muted)]">{TYPE_HINT[type]}</span>
      </label>

      {type === "keyword" && (
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-1 flex-col gap-1 text-xs">
            <span className="text-[var(--color-muted)]">Keyword</span>
            <input
              name="keyword"
              placeholder="Add to cart"
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--color-muted)]">Must be</span>
            <select
              name="match"
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
            >
              <option value="present">present</option>
              <option value="absent">absent</option>
            </select>
          </label>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[var(--color-muted)]">Interval (s)</span>
          <input
            name="intervalS"
            type="number"
            min={60}
            defaultValue={60}
            className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs">
          <span className="text-[var(--color-muted)]">Alert email (defaults to yours)</span>
          <input
            name="alertEmail"
            type="email"
            defaultValue={defaultEmail}
            placeholder="you@example.com"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      {error && <p className="text-xs text-[var(--color-fail)]">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create monitor"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-1.5 text-sm text-[var(--color-muted)]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
