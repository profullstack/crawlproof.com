"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ALERT_CATEGORIES, type Recency } from "@/lib/alerts/categories";
import { createAlert, testRunAlert } from "@/app/actions/alerts";
import type { SerpResult } from "@/lib/alerts/valueserp";

// People-tracking templates (name / reputation / impersonation / legal) are
// withheld from the v1 picker pending a trust-and-safety policy.
const PICKABLE = ALERT_CATEGORIES.filter((c) => !c.gated);

const RECENCIES: { value: Recency; label: string }[] = [
  { value: "day", label: "Past 24 hours" },
  { value: "week", label: "Past week" },
  { value: "month", label: "Past month" },
  { value: "any", label: "Any time" },
];

export function CreateAlert({ remainingSlots }: { remainingSlots: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [categoryKey, setCategoryKey] = useState(PICKABLE[0].key);
  const [term, setTerm] = useState("");
  const [recency, setRecency] = useState<Recency>(PICKABLE[0].defaultRecency);
  const [frequency, setFrequency] = useState<"daily" | "hourly">("daily");
  const [preview, setPreview] = useState<SerpResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const category = useMemo(() => PICKABLE.find((c) => c.key === categoryKey)!, [categoryKey]);
  const atCap = remainingSlots <= 0;

  function pickCategory(key: string) {
    const cat = PICKABLE.find((c) => c.key === key)!;
    setCategoryKey(cat.key);
    setRecency(cat.defaultRecency);
    setPreview(null);
    setError(null);
    setNotice(null);
  }

  function runTest() {
    setError(null);
    setNotice(null);
    if (!term.trim()) return setError(`${category.inputLabel} is required.`);
    startTransition(async () => {
      const res = await testRunAlert({ category: categoryKey, term, customQuery: term });
      if (!res.ok) return setError(res.error);
      setPreview(res.results);
      if (res.results.length === 0)
        setNotice("No current results — you'll be emailed when something new appears.");
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!term.trim()) return setError(`${category.inputLabel} is required.`);
    startTransition(async () => {
      const res = await createAlert({ category: categoryKey, term, customQuery: term, recency, frequency });
      if (!res.ok) return setError(res.error);
      setTerm("");
      setPreview(null);
      setNotice("Alert created. First check runs shortly.");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="card space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium">What do you want to track?</label>
        <div className="flex flex-wrap gap-2">
          {PICKABLE.map((c) => (
            <button
              type="button"
              key={c.key}
              onClick={() => pickCategory(c.key)}
              className={`badge ${c.key === categoryKey ? "badge-pass" : ""}`}
            >
              {c.title}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-[var(--color-muted)]">{category.template}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <input
          className="input"
          placeholder={category.inputPlaceholder}
          aria-label={category.inputLabel}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <select
          className="input"
          value={recency}
          onChange={(e) => setRecency(e.target.value as Recency)}
          aria-label="Recency"
        >
          {RECENCIES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as "daily" | "hourly")}
          aria-label="Check frequency"
        >
          <option value="daily">Daily</option>
          <option value="hourly">Hourly</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={runTest} disabled={pending}>
          {pending ? "Checking…" : "See current results"}
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending || atCap}>
          Create alert
        </button>
        {atCap && (
          <span className="text-xs text-[var(--color-warn)]">
            You're at your active-alert limit — pause one or upgrade.
          </span>
        )}
      </div>

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-accent)]">{notice}</p>}

      {preview && preview.length > 0 && (
        <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Current results preview (you'll only be emailed NEW ones)
          </p>
          {preview.map((r) => (
            <a key={r.url} href={r.url} target="_blank" rel="noreferrer" className="block text-sm">
              <span className="font-medium text-[var(--color-accent)]">{r.title || r.url}</span>
              <span className="block truncate text-xs text-[var(--color-muted)]">{r.url}</span>
            </a>
          ))}
        </div>
      )}
    </form>
  );
}
