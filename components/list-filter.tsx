"use client";

import {
  createContext,
  useContext,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { matchingIds, type FilterItem } from "@/lib/list-filter";

/**
 * A type-to-narrow filter over a list the server already rendered.
 *
 * Three pieces, so a page can put the box where it belongs while the rows stay
 * server components:
 *
 *   <ListFilter items={[{ id, text }]}>   provider: owns the query
 *     <ListFilterInput label="Filter projects" noun="projects" />
 *     <ul>{rows.map(r => <ListFilterRow key={r.id} id={r.id} as="li">…</ListFilterRow>)}</ul>
 *     <ListFilterEmpty noun="projects" />
 *   </ListFilter>
 *
 * Nothing here fetches or navigates: the rows are already in the page, and a
 * filter that hit the server would make every keystroke wait on eleven RPCs.
 * It also means the aggregate figures above a list keep reporting the whole
 * account — the filter narrows what you are looking at, not what was measured.
 *
 * Filtered-out rows keep their markup and take the `hidden` attribute rather
 * than unmounting, so logos and sparklines do not reload when the box is
 * cleared. That relies on the row's own classes not setting `display`, which
 * would beat the UA rule behind `hidden`; every current caller is a plain
 * block li or tr.
 */

type FilterContext = {
  query: string;
  setQuery: (query: string) => void;
  /** Ids to show, or null when the box is empty and everything shows. */
  visible: Set<string> | null;
  total: number;
  matched: number;
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
  items,
  children,
}: {
  /** Every row in the list, with the text it should match on. */
  items: readonly FilterItem[];
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => matchingIds(items, query), [items, query]);
  const value = useMemo(
    () => ({
      query,
      setQuery,
      visible,
      total: items.length,
      matched: visible ? visible.size : items.length,
    }),
    [query, visible, items.length],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function ListFilterInput({
  label,
  noun,
  className,
}: {
  /** Accessible name, and the placeholder: "Filter projects". */
  label: string;
  /** Plural noun for the count line: "3 of 21 projects". */
  noun: string;
  className?: string;
}) {
  const { query, setQuery, matched, total } = useFilter("ListFilterInput");
  const id = useId();
  const filtering = query.trim().length > 0;
  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <input
        id={id}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        // Escape clears without reaching for the mouse; the browser's own
        // search-input clear button is not on every engine.
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setQuery("");
          }
        }}
        aria-label={label}
        placeholder={label}
        autoComplete="off"
        spellCheck={false}
        className="w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--color-accent)] sm:w-60"
      />
      {filtering && (
        <span
          className="whitespace-nowrap text-xs tabular-nums text-[var(--color-muted)]"
          role="status"
        >
          {matched} of {total} {noun}
        </span>
      )}
    </div>
  );
}

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
    <Tag className={className} hidden={visible !== null && !visible.has(id)}>
      {children}
    </Tag>
  );
}

/** The "nothing matched" line. Renders only when a query hid every row. */
export function ListFilterEmpty({ noun }: { noun: string }) {
  const { query, matched } = useFilter("ListFilterEmpty");
  const trimmed = query.trim();
  if (!trimmed || matched > 0) return null;
  return (
    <p className="py-4 text-sm text-[var(--color-muted)]" role="status">
      No {noun} match &ldquo;{trimmed}&rdquo;.
    </p>
  );
}
