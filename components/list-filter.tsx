"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ANY_STATUS } from "@/lib/list-filter";

/**
 * Search + status filter for a long dashboard list.
 *
 * State lives in the URL, like RangeTabs — so a filtered view survives a
 * refresh, can be linked to a colleague, and is readable by the server
 * component that does the filtering. Navigation runs in a transition so the list
 * keeps its last render while the server re-renders, rather than flashing empty.
 *
 * The search box is debounced and does NOT navigate per keystroke. Each
 * navigation re-renders a server component that loads range totals and a daily
 * series, so per-keystroke routing would issue a burst of those for prefixes
 * nobody is looking at. 250ms is below the threshold where typing feels laggy
 * and above the inter-key interval of ordinary typing.
 */
export function ListFilter({
  total,
  shown,
  statuses,
  label,
  placeholder,
}: {
  /** Items before filtering — "of N" in the count line. */
  total: number;
  /** Items after filtering, for the count line. */
  shown: number;
  /** Status options with their counts. Omit or empty for a list with no status. */
  statuses?: { value: string; label: string; count: number }[];
  /** Plural noun for the count line: "campaigns", "projects", "slots". */
  label: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const urlQ = searchParams.get("q") ?? "";
  const status = searchParams.get("status") ?? ANY_STATUS;
  const [text, setText] = useState(urlQ);

  // Keep the box in step when the URL changes from outside it — the Clear
  // button, the back button, a pasted link. Guarded on the value actually
  // differing so it never fights what is being typed.
  const lastUrlQ = useRef(urlQ);
  useEffect(() => {
    if (urlQ !== lastUrlQ.current) {
      lastUrlQ.current = urlQ;
      setText(urlQ);
    }
  }, [urlQ]);

  function navigate(next: { q?: string; status?: string }) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.q !== undefined) {
      if (next.q) params.set("q", next.q);
      else params.delete("q");
    }
    if (next.status !== undefined) {
      if (next.status && next.status !== ANY_STATUS) params.set("status", next.status);
      else params.delete("status");
    }
    // Any change to the filter invalidates the page number: staying on page 6
    // of a list that now has two matches would render an empty list, which
    // reads as "no results".
    params.delete("page");
    const qs = params.toString();
    lastUrlQ.current = next.q ?? urlQ;
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }

  // Debounce the text box only. The select is a deliberate single act and should
  // take effect at once.
  useEffect(() => {
    if (text === urlQ) return;
    const t = setTimeout(() => navigate({ q: text }), 250);
    return () => clearTimeout(t);
    // navigate closes over searchParams, which changes on every navigation; the
    // effect is keyed on the text the user typed and the URL it is compared to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, urlQ]);

  const filtering = Boolean(urlQ) || status !== ANY_STATUS;

  return (
    <div
      data-pending={pending ? "" : undefined}
      className="flex flex-wrap items-center gap-2"
    >
      <label className="relative">
        <span className="sr-only">Search {label}</span>
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder ?? `Search ${label}…`}
          className="w-48 rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-1.5 text-sm sm:w-64"
        />
      </label>

      {statuses && statuses.length > 0 && (
        <label>
          <span className="sr-only">Filter {label} by status</span>
          <select
            value={status}
            onChange={(e) => navigate({ status: e.target.value })}
            className="rounded-lg border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm"
          >
            <option value={ANY_STATUS}>All statuses</option>
            {statuses.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label} ({s.count})
              </option>
            ))}
          </select>
        </label>
      )}

      <span className="text-sm text-[var(--color-muted)] tabular-nums">
        {filtering ? (
          <>
            {shown.toLocaleString()} of {total.toLocaleString()} {label}
          </>
        ) : (
          <>
            {total.toLocaleString()} {label}
          </>
        )}
      </span>

      {filtering && (
        <button
          type="button"
          onClick={() => navigate({ q: "", status: ANY_STATUS })}
          className="text-sm text-[var(--color-accent)] hover:underline"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/**
 * Previous/next paging for a filtered list.
 *
 * Deliberately not numbered pages. The lists this serves are scanned rather than
 * navigated — nobody knows that the campaign they want is on page 7 — so the
 * search box is the way to jump and the pager only exists to walk the tail.
 */
export function ListPager({
  page,
  pages,
  total,
  label,
}: {
  page: number;
  pages: number;
  total: number;
  label: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  if (pages <= 1) return null;

  function go(to: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (to <= 1) params.delete("page");
    else params.set("page", String(to));
    const qs = params.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }

  return (
    <div
      data-pending={pending ? "" : undefined}
      className="mt-3 flex items-center justify-between gap-3 text-sm"
    >
      <button
        type="button"
        onClick={() => go(page - 1)}
        disabled={page <= 1}
        className="btn text-sm disabled:opacity-40"
      >
        ← Previous
      </button>
      <span className="text-[var(--color-muted)] tabular-nums">
        Page {page} of {pages} · {total.toLocaleString()} {label}
      </span>
      <button
        type="button"
        onClick={() => go(page + 1)}
        disabled={page >= pages}
        className="btn text-sm disabled:opacity-40"
      >
        Next →
      </button>
    </div>
  );
}
