"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createProject } from "@/app/actions/createProject";

// Only honour same-site relative paths (guards against open redirects).
function safeNext(next: string | null | undefined): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : null;
}

function deriveName(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function NewProjectForm({ next }: { next?: string | null }) {
  const router = useRouter();
  // e.g. /projects/new?next=/ads/slots — return to Monetize after creating so
  // the new site is right there to "Enable ads".
  const nextPath = safeNext(next);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [url, setUrl] = useState("");
  const [schedule, setSchedule] = useState<"off" | "daily" | "weekly" | "monthly">("off");
  const [error, setError] = useState<string | null>(null);

  function onUrlChange(next: string) {
    setUrl(next);
    if (!nameTouched) {
      setName(deriveName(next));
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Final fallback — derive on submit if somehow still empty.
    const finalName = name || deriveName(url);
    startTransition(async () => {
      const res = await createProject({ name: finalName, url, schedule });
      if (!res.ok) {
        setError(res.error ?? "Could not create project.");
        return;
      }
      router.push(nextPath ?? `/projects/${res.id}`);
    });
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          URL
        </label>
        <input
          className="input mt-1"
          type="url"
          placeholder="https://example.com"
          required
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          autoFocus
        />
      </div>
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Project name
        </label>
        <input
          className="input mt-1"
          placeholder="Auto-filled from URL"
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
          }}
        />
      </div>
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Schedule
        </label>
        <select
          className="input mt-1"
          value={schedule}
          onChange={(e) => setSchedule(e.target.value as typeof schedule)}
        >
          <option value="off">No schedule</option>
          <option value="daily">Daily re-audits</option>
          <option value="weekly">Weekly re-audits</option>
          <option value="monthly">Monthly re-audits</option>
        </select>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Scheduled re-runs spend credits each time they fire — based on the
          engines you select on the project page.
        </p>
      </div>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
