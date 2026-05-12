"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createProject } from "@/app/actions/createProject";

export function NewProjectForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [schedule, setSchedule] = useState<"off" | "weekly" | "monthly">("off");
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await createProject({ name, url, schedule });
      if (!res.ok) {
        setError(res.error ?? "Could not create project.");
        return;
      }
      router.push(`/projects/${res.id}`);
    });
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      <input
        className="input"
        placeholder="Project name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="input"
        type="url"
        placeholder="https://example.com"
        required
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <select
        className="input"
        value={schedule}
        onChange={(e) => setSchedule(e.target.value as typeof schedule)}
      >
        <option value="off">No schedule</option>
        <option value="weekly">Weekly re-audits (Pro)</option>
        <option value="monthly">Monthly re-audits (Pro)</option>
      </select>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
