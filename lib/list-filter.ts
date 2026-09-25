/**
 * Matching for the client-side filters on the dashboard lists.
 *
 * The dashboard lists (projects, ad campaigns, portfolio properties) are all
 * rendered whole by the server: an account with forty properties gets forty
 * cards, and finding one means scrolling. These helpers back a filter box that
 * narrows the rendered list in the browser without a round trip — no new query,
 * no new RPC, and the totals above the list keep describing the whole account
 * rather than silently re-scoping to whatever was typed.
 *
 * Kept apart from the component so the matching rules are testable in the node
 * test environment (tests/list-filter.test.ts); components/list-filter.tsx is
 * the only caller.
 */

/** One row of a filterable list: a stable id and everything it matches on. */
export type FilterItem = {
  id: string;
  /** Name, URL, slug, status — whatever the row shows and a reader may type. */
  text: string;
};

/**
 * Split a query into the terms every match must contain.
 *
 * Whitespace separates terms and they are ANDed, so "shop paused" finds the
 * paused campaign for the shop rather than every row mentioning either word.
 * Order does not matter, which is the point: the terms come from different
 * parts of the row's text.
 */
export function filterTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Case-insensitive substring match on every term. No terms matches anything.
 *
 * Terms are lowercased here as well as in `filterTerms`, so this holds up when
 * called with a term that did not come through there.
 */
export function matchesTerms(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = text.toLowerCase();
  return terms.every((term) => haystack.includes(term.toLowerCase()));
}

/**
 * The ids to keep for a query, or `null` when the query is empty.
 *
 * `null` rather than "every id": an empty box is the common case and means
 * every row renders, including rows whose id was never registered.
 */
export function matchingIds(
  items: readonly FilterItem[],
  query: string,
): Set<string> | null {
  const terms = filterTerms(query);
  if (terms.length === 0) return null;
  const out = new Set<string>();
  for (const item of items) {
    if (matchesTerms(item.text, terms)) out.add(item.id);
  }
  return out;
}
