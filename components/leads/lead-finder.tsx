"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { findLeadsAction } from "@/app/actions/leads";

/**
 * The "add leads" box. A search query finds businesses; a directory URL mines
 * one page's outbound links.
 *
 * Neither scans the businesses it finds. Scanning exists to supply findings
 * for the CrawlProof audit pitch, and a project pitching its own offer has no
 * use for them — so firing a scan at every discovered domain would spend
 * worker time on evidence nobody cites, and point a scanner at people whose
 * only involvement was appearing in a search. A campaign that does pitch an
 * audit turns scanning back on explicitly.
 */
export function LeadFinder({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"query" | "seed">("query");
  const [value, setValue] = useState("");
  const [limit, setLimit] = useState(10);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setNote(null);
    setError(null);
    start(async () => {
      const res = await findLeadsAction(
        mode === "query"
          ? { projectId, query: value, limit }
          : { projectId, seedUrl: value, limit },
      );
      if (res.ok) {
        setNote(res.note);
        setValue("");
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-[var(--color-border)] p-0.5 text-sm">
          <button
            type="button"
            onClick={() => setMode("query")}
            className={`rounded-md px-3 py-1 ${mode === "query" ? "bg-[var(--color-border)] text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
          >
            Search
          </button>
          <button
            type="button"
            onClick={() => setMode("seed")}
            className={`rounded-md px-3 py-1 ${mode === "seed" ? "bg-[var(--color-border)] text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
          >
            Directory page
          </button>
        </div>
        <input
          className="input min-w-[16rem] flex-1"
          placeholder={
            mode === "query"
              ? "dentists in Miami"
              : "https://example.com/best-agencies-in-austin"
          }
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <select
          className="input w-24"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          aria-label="How many leads"
        >
          {[5, 10, 25].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button onClick={submit} disabled={pending || !value.trim()} className="btn btn-primary">
          {pending ? "Finding…" : "Find leads"}
        </button>
      </div>
      <p className="mt-2 text-xs text-[var(--color-muted)]">
        {mode === "query"
          ? "Finds businesses and looks up a contact address for each. It does not scan them."
          : "Every outbound link on that page becomes a candidate. Platforms and aggregators are filtered out."}
      </p>
      {note && <p className="mt-2 text-sm text-[var(--color-fg)]">{note}</p>}
      {error && <p className="mt-2 text-sm text-[var(--color-danger,#f87171)]">{error}</p>}
    </div>
  );
}
