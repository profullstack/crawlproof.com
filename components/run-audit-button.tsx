"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runAuditForProject } from "@/app/actions/runAudit";
import { ENGINES, type Engine } from "@/lib/credits";

export function RunAuditButton({
  projectId,
  url,
}: {
  projectId: string;
  url: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [engine, setEngine] = useState<Engine>("rule");
  const [error, setError] = useState<string | null>(null);
  const cost = ENGINES[engine].cost;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input w-auto py-1 text-sm"
          value={engine}
          onChange={(e) => setEngine(e.target.value as Engine)}
          disabled={pending}
        >
          {(Object.keys(ENGINES) as Engine[]).map((k) => {
            const m = ENGINES[k];
            const price = m.cost === 0 ? "free" : `${m.cost} credit${m.cost === 1 ? "" : "s"}`;
            return (
              <option key={k} value={k} disabled={!m.available}>
                {m.label} · {price}
              </option>
            );
          })}
        </select>
        <button
          className="btn btn-primary"
          disabled={pending}
          onClick={() => {
            setError(null);
            start(async () => {
              const res = await runAuditForProject({ projectId, url, engine });
              if (res.ok) router.push(`/audits/${res.id}`);
              else setError(res.error);
            });
          }}
        >
          {pending ? "Starting…" : `Run · ${cost === 0 ? "free" : `${cost} credit${cost === 1 ? "" : "s"}`}`}
        </button>
      </div>
      {error && <p className="text-xs text-[var(--color-fail)]">{error}</p>}
    </div>
  );
}
