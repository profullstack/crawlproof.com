"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ANY_STATUS,
  DEFAULT_PER_PAGE,
  applyListQuery,
  filterList,
  needsFilter,
  paginate,
  statusCounts,
  LIST_ROW_SPEC,
  type ListQuery,
  type ListRow,
} from "@/lib/list-filter";

/**
 * Search, status filter and paging for a long dashboard list, run entirely in
 * the browser.
 *
 * The server renders every row and hands this component a descriptor per row
 * (id, the text it matches on, its status). Typing filters those descriptors and
 * hides the rows that fall out — no navigation, no debounce, no server render
 * per keystroke, so the list narrows as fast as the keys go down. That is the
 * whole reason this is not the obvious "put the query in the URL and filter on
 * the server" design: on these pages a server render re-runs the range totals,
 * the daily series and the status derivation for the whole account, which is
 * work no prefix deserves.
 *
 * What the URL approach bought is kept anyway. The current query is written back
 * with `history.replaceState`, which updates the address bar without asking
 * Next.js to route, so a filtered view is still a link you can send. And the
 * page passes its `parseListQuery(searchParams)` in as `initial`, so a link
 * arrives already filtered in the server's own HTML rather than flashing the
 * full list and then narrowing it on hydration.
 *
 * The cost, stated plainly: every row is in the DOM, including the ones the
 * filter and the pager are hiding. Hidden subtrees skip layout and paint, but
 * they are still parsed and hydrated, so an account with 465 campaigns ships all
 * 465 cards. Paging still earns its keep for what it does to the visible list.
 *
 * Usage — the provider wraps the whole list, the parts place themselves:
 *
 *   <ListFilter rows={rows} initial={listQuery} perPage={25} label="campaigns">
 *     <ListFilterBar placeholder="Search name, domain or slug…" />
 *     <ListFilterEmpty>No campaigns match that filter.</ListFilterEmpty>
 *     <ul>
 *       {campaigns.map((c) => (
 *         <ListFilterRow key={c.id} id={c.id} as="li" className="card p-4">…</ListFilterRow>
 *       ))}
 *     </ul>
 *     <ListPager />
 *   </ListFilter>
 */

type FilterContext = {
  query: ListQuery;
  setQuery: (next: Partial<ListQuery>) => void;
  clear: () => void;
  /** Ids on the current page of the filtered list. */
  visible: Set<string>;
  /** Rows before filtering. */
  total: number;
  /** Rows after filtering, before paging — what the count line reports. */
  matched: number;
  page: number;
  pages: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** Options for the status dropdown; empty when the list has no status. */
  statuses: { value: string; label: string; count: number }[];
  filtering: boolean;
  /** False for a list too short to be worth a filter row at all. */
  worthFiltering: boolean;
  label: string;
};

const Ctx = createContext<FilterContext | null>(null);

function useFilter(component: string): FilterContext {
  const value = useContext(Ctx);
  if (!value) {
    throw new Error(`<${component}> must be rendered inside <ListFilter>`);
  }
  return value;
}

export function ListFilter({
  rows,
  initial,
  perPage = DEFAULT_PER_PAGE,
  label,
  children,
}: {
  /** Every row in the list, in render order. */
  rows: ListRow[];
  /** The query the page was loaded with, from parseListQuery(searchParams). */
  initial: ListQuery;
  perPage?: number;
  /** Plural noun for the count line: "campaigns", "projects", "sites". */
  label: string;
  children: ReactNode;
}) {
  // A list with no status dimension ignores `?status=` entirely, rather than
  // filtering every row out against a status none of them carries. /dashboard
  // spends that parameter on its Active/Paused/Archived tabs.
  const hasStatuses = useMemo(() => rows.some((row) => row.status), [rows]);

  const [query, setState] = useState<ListQuery>({
    q: initial.q,
    status: hasStatuses ? initial.status : ANY_STATUS,
    page: initial.page,
  });

  const filtered = useMemo(
    () => filterList(rows, query, LIST_ROW_SPEC),
    [rows, query],
  );
  const paged = useMemo(
    () => paginate(filtered, query.page, perPage),
    [filtered, query.page, perPage],
  );
  const visible = useMemo(
    () => new Set(paged.items.map((row) => row.id)),
    [paged],
  );
  const statuses = useMemo(() => {
    if (!hasStatuses) return [];
    return [...statusCounts(rows, query, LIST_ROW_SPEC)]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: value, count }));
  }, [hasStatuses, rows, query]);

  // Mirror the query into the address bar without routing. replaceState leaves
  // no history entry, so Back still leaves the page rather than stepping through
  // every prefix that was typed on the way here.
  useEffect(() => {
    const search = applyListQuery(window.location.search, query, {
      withStatus: hasStatuses,
    });
    const next = `${window.location.pathname}${search ? `?${search}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", next);
    }
  }, [query, hasStatuses]);

  const value = useMemo<FilterContext>(() => {
    const setQuery = (next: Partial<ListQuery>) =>
      setState((current) => ({
        ...current,
        ...next,
        // Any change to what is being matched invalidates the page number:
        // staying on page 6 of a list that now has two matches would render an
        // empty list, which reads as "no results".
        page: next.page ?? (next.q !== undefined || next.status !== undefined ? 1 : current.page),
      }));
    return {
      query,
      setQuery,
      clear: () => setState({ q: "", status: ANY_STATUS, page: 1 }),
      visible,
      total: rows.length,
      matched: paged.total,
      // Clamped, so the pager never reads "Page 7 of 2" after a filter narrowed
      // the list under the page the viewer was on.
      page: paged.page,
      pages: paged.pages,
      hasPrev: paged.hasPrev,
      hasNext: paged.hasNext,
      statuses,
      filtering: Boolean(query.q) || query.status !== ANY_STATUS,
      worthFiltering: needsFilter(rows.length),
      label,
    };
  }, [query, visible, rows.length, paged, statuses, label]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Search box, status dropdown, count and Clear. Hides itself on a short list. */
export function ListFilterBar({
  placeholder,
  className,
}: {
  placeholder?: string;
  className?: string;
}) {
  const {
    query,
    setQuery,
    clear,
    total,
    matched,
    statuses,
    filtering,
    worthFiltering,
    label,
  } = useFilter("ListFilterBar");
  const id = useId();

  if (!worthFiltering) return null;

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
      <input
        id={id}
        type="search"
        value={query.q}
        onChange={(event) => setQuery({ q: event.target.value })}
        // Escape empties the box: the fastest way back to the whole list from
        // the keyboard, and not every engine draws its own clear affordance on
        // a search input.
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setQuery({ q: "" });
          }
        }}
        placeholder={placeholder ?? `Search ${label}…`}
        aria-label={`Search ${label}`}
        autoComplete="off"
        spellCheck={false}
        className="w-48 rounded-lg border border-[var(--color-border)] bg-transparent px-3 py-1.5 text-sm sm:w-64"
      />

      {statuses.length > 0 && (
        <label>
          <span className="sr-only">Filter {label} by status</span>
          <select
            value={query.status}
            onChange={(event) => setQuery({ status: event.target.value })}
            className="rounded-lg border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm"
          >
            <option value={ANY_STATUS}>All statuses</option>
            {statuses.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label} ({status.count})
              </option>
            ))}
          </select>
        </label>
      )}

      <span className="text-sm tabular-nums text-[var(--color-muted)]" role="status">
        {filtering ? (
          <>
            {matched.toLocaleString()} of {total.toLocaleString()} {label}
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
          onClick={clear}
          className="text-sm text-[var(--color-accent)] hover:underline"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/**
 * One row of the list, hidden when the filter or the pager excludes it.
 *
 * `hidden` rather than unmounting, so a row's logo and sparkline are not
 * re-fetched and re-rendered every time the box is cleared. This relies on the
 * row's own classes not setting `display`, which would beat the UA rule behind
 * the attribute; every caller here is a plain block li or tr.
 */
export function ListFilterRow({
  id,
  as: Tag = "div",
  className,
  children,
}: {
  id: string;
  as?: "div" | "li" | "tr";
  className?: string;
  children: ReactNode;
}) {
  const { visible } = useFilter("ListFilterRow");
  return (
    <Tag className={className} hidden={!visible.has(id)}>
      {children}
    </Tag>
  );
}

/**
 * Whether a row is currently hidden, for a row that renders its own element.
 *
 * `ListFilterRow` cannot wrap a component whose root is already the `li` the
 * list needs — nesting one inside another is invalid — so such a row reads this
 * and applies `hidden` itself. See components/ads/slot-row.tsx.
 */
export function useListRowHidden(id: string): boolean {
  const { visible } = useFilter("useListRowHidden");
  return !visible.has(id);
}

/** Shown in place of the list when a query hid every row. */
export function ListFilterEmpty({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { matched, total } = useFilter("ListFilterEmpty");
  if (total === 0 || matched > 0) return null;
  return (
    <div
      role="status"
      className={
        className ?? "card mt-4 p-8 text-center text-[var(--color-muted)]"
      }
    >
      {children}
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
export function ListPager() {
  const { page, pages, matched, hasPrev, hasNext, setQuery, label } =
    useFilter("ListPager");

  if (pages <= 1) return null;

  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-sm">
      <button
        type="button"
        onClick={() => setQuery({ page: page - 1 })}
        disabled={!hasPrev}
        className="btn text-sm disabled:opacity-40"
      >
        ← Previous
      </button>
      <span className="tabular-nums text-[var(--color-muted)]">
        Page {page} of {pages} · {matched.toLocaleString()} {label}
      </span>
      <button
        type="button"
        onClick={() => setQuery({ page: page + 1 })}
        disabled={!hasNext}
        className="btn text-sm disabled:opacity-40"
      >
        Next →
      </button>
    </div>
  );
}
