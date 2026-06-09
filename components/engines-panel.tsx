"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_PROJECT_ENGINES, ENGINES, selectionCost, type Engine } from "@/lib/credits";
import { runScanForProject } from "@/app/actions/runAudit";
import { updateProjectEngines } from "@/app/actions/projects";

const ENGINE_ORDER: Engine[] = ["rule", "spec", "dns", "links", "vu1nz", "claude", "openai", "gemini", "perplexity", "qwen", "kimi", "deepseek"];

export function EnginesPanel({
  projectId,
  url,
  defaultEngines,
}: {
  projectId: string;
  url: string;
  defaultEngines: Engine[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Engine[]>(
    defaultEngines.length > 0 ? defaultEngines : DEFAULT_PROJECT_ENGINES,
  );
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const cost = useMemo(() => selectionCost(selected), [selected]);
  const dirty = useMemo(() => {
    const a = [...selected].sort().join(",");
    const b = [...defaultEngines].sort().join(",");
    return a !== b;
  }, [selected, defaultEngines]);

  function toggle(e: Engine) {
    setSelected((cur) =>
      cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e],
    );
    setConfirming(false);
    setError(null);
  }

  function onRun() {
    setError(null);
    if (selected.length === 0) {
      setError("Pick at least one engine.");
      return;
    }
    if (!confirming && cost > 0) {
      setConfirming(true);
      return;
    }
    start(async () => {
      const res = await runScanForProject({ projectId, url, engines: selected });
      if (!res.ok) {
        setError(res.error);
        setConfirming(false);
        return;
      }
      // Route to the scan-run page so the user sees every engine's progress
      // side-by-side, not just one of them.
      router.push(`/projects/${projectId}/runs/${res.scanRunId}`);
    });
  }

  function onSaveDefault() {
    setError(null);
    start(async () => {
      const res = await updateProjectEngines({ projectId, engines: selected });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSavedAt(Date.now());
      router.refresh();
    });
  }

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold">Engines</h3>
        <span className="text-xs text-[var(--color-muted)]">
          Pick one or more — each paid engine adds 20 credits per scan.
        </span>
      </div>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {ENGINE_ORDER.map((e) => {
          const meta = ENGINES[e];
          if (!meta) return null;
          const checked = selected.includes(e);
          return (
            <li key={e}>
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${
                  checked
                    ? "border-[var(--color-accent)] bg-[var(--color-bg)]"
                    : "border-[var(--color-border)]"
                } ${meta.available ? "" : "opacity-50"}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  disabled={!meta.available || pending}
                  checked={checked}
                  onChange={() => toggle(e)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{meta.label}</span>
                    <span className="font-mono text-xs">
                      {meta.cost === 0 ? "free" : `${meta.cost} cr`}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--color-muted)]">{meta.blurb}</p>
                </div>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          className="btn btn-primary"
          disabled={pending || selected.length === 0}
          onClick={onRun}
        >
          {pending
            ? "Starting…"
            : confirming
              ? `Confirm — spend ${cost} credit${cost === 1 ? "" : "s"}`
              : cost === 0
                ? "Run scan (free)"
                : `Run scan · ${cost} credit${cost === 1 ? "" : "s"}`}
        </button>
        {confirming && !pending && (
          <button
            className="btn"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        )}
        <button
          className="btn"
          disabled={pending || !dirty || selected.length === 0}
          onClick={onSaveDefault}
          title="Used for scheduled re-runs"
        >
          {savedAt ? "Saved ✓" : "Save as default"}
        </button>
        <span className="ml-auto text-xs text-[var(--color-muted)]">
          {dirty
            ? "Unsaved changes — Save as default to apply to weekly re-runs."
            : "These are the engines weekly re-runs will use."}
        </span>
      </div>

      {error && <p className="mt-2 text-sm text-[var(--color-fail)]">{error}</p>}
    </div>
  );
}
