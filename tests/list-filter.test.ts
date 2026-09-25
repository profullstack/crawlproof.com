import { describe, expect, it } from "vitest";
import {
  ANY_STATUS,
  filterAndPaginate,
  filterList,
  matchesSearch,
  needsFilter,
  paginate,
  parseListQuery,
  statusCounts,
  FILTER_THRESHOLD,
} from "@/lib/list-filter";

type Item = { name: string; url?: string | null; status: string };

const spec = {
  fields: (i: Item) => [i.name, i.url, i.status],
  statusOf: (i: Item) => i.status,
};

const items: Item[] = [
  { name: "Acme Widgets", url: "https://acme.example", status: "active" },
  { name: "Beta Blog", url: "https://beta.example", status: "paused" },
  { name: "Gamma Shop", url: null, status: "active" },
  { name: "acme spare parts", url: "https://parts.example", status: "archived" },
];

const query = (over: Partial<ReturnType<typeof parseListQuery>> = {}) => ({
  q: "",
  status: ANY_STATUS,
  page: 1,
  ...over,
});

describe("reading the query off a URL", () => {
  it("defaults to no search, any status, page one", () => {
    expect(parseListQuery(undefined)).toEqual({ q: "", status: ANY_STATUS, page: 1 });
    expect(parseListQuery({})).toEqual({ q: "", status: ANY_STATUS, page: 1 });
  });

  it("lowercases and trims the search so matching is case-insensitive", () => {
    expect(parseListQuery({ q: "  AcMe  " }).q).toBe("acme");
  });

  it("survives everything a hand-typed query string can carry", () => {
    // These are user-editable; a dashboard must not 500 on a bad page number.
    expect(parseListQuery({ page: "0" }).page).toBe(1);
    expect(parseListQuery({ page: "-3" }).page).toBe(1);
    expect(parseListQuery({ page: "nonsense" }).page).toBe(1);
    expect(parseListQuery({ page: "" }).page).toBe(1);
    // Repeated params arrive as arrays.
    expect(parseListQuery({ q: ["beta", "gamma"] }).q).toBe("beta");
  });
});

describe("searching", () => {
  it("matches any field, case-insensitively", () => {
    expect(filterList(items, query({ q: "acme" }), spec).map((i) => i.name)).toEqual([
      "Acme Widgets",
      "acme spare parts",
    ]);
    // The URL is a field too.
    expect(filterList(items, query({ q: "parts.example" }), spec)).toHaveLength(1);
  });

  it("requires every term, so a longer query narrows", () => {
    // AND, not OR: two words is almost always a narrowing, and returning MORE
    // results for a longer query reads as the search being broken.
    expect(filterList(items, query({ q: "acme spare" }), spec).map((i) => i.name)).toEqual([
      "acme spare parts",
    ]);
    expect(filterList(items, query({ q: "acme widgets" }), spec)).toHaveLength(1);
  });

  it("can find a row by its status text", () => {
    expect(filterList(items, query({ q: "archived" }), spec)).toHaveLength(1);
  });

  it("skips null fields instead of matching them", () => {
    // Gamma Shop has no url; a naive join would make "null" a searchable word.
    expect(filterList(items, query({ q: "null" }), spec)).toHaveLength(0);
    expect(matchesSearch(items[2], "gamma", spec)).toBe(true);
  });

  it("does not match a term that spans two fields", () => {
    // Fields are joined with a separator so "widgets https" cannot match across
    // the boundary between name and url.
    expect(matchesSearch(items[0], "widgetshttps", spec)).toBe(false);
  });

  it("returns everything for an empty search", () => {
    expect(filterList(items, query(), spec)).toHaveLength(items.length);
  });
});

describe("status filtering", () => {
  it("narrows to one status", () => {
    expect(filterList(items, query({ status: "active" }), spec)).toHaveLength(2);
  });

  it("combines with the search", () => {
    expect(
      filterList(items, query({ q: "acme", status: "archived" }), spec).map((i) => i.name),
    ).toEqual(["acme spare parts"]);
  });

  it("is ignored on a list with no status dimension", () => {
    const noStatus = { fields: (i: Item) => [i.name] };
    expect(filterList(items, query({ status: "active" }), noStatus)).toHaveLength(4);
  });
});

describe("status counts for the dropdown", () => {
  it("counts over the whole list regardless of the selected status", () => {
    // A dropdown whose counts moved as you changed the selection would describe
    // the current selection rather than what you could select next.
    const all = statusCounts(items, query(), spec);
    const whileFiltered = statusCounts(items, query({ status: "active" }), spec);
    expect([...whileFiltered]).toEqual([...all]);
    expect(all.get("active")).toBe(2);
    expect(all.get("paused")).toBe(1);
  });

  it("does respect the search, so the counts describe what you would get", () => {
    const counts = statusCounts(items, query({ q: "acme" }), spec);
    expect(counts.get("active")).toBe(1);
    expect(counts.get("archived")).toBe(1);
    expect(counts.has("paused")).toBe(false);
  });
});

describe("paging", () => {
  const many = Array.from({ length: 47 }, (_, i) => ({
    name: `Item ${i}`,
    status: "active",
  }));

  it("splits into pages and reports the shape", () => {
    const p = paginate(many, 1, 10);
    expect(p.items).toHaveLength(10);
    expect(p.pages).toBe(5);
    expect(p.total).toBe(47);
    expect(p.hasPrev).toBe(false);
    expect(p.hasNext).toBe(true);
  });

  it("gives the remainder on the last page", () => {
    const p = paginate(many, 5, 10);
    expect(p.items).toHaveLength(7);
    expect(p.hasNext).toBe(false);
    expect(p.hasPrev).toBe(true);
  });

  it("clamps a page past the end instead of rendering nothing", () => {
    // Filtering down while on page 8 is the common way to get here, and an empty
    // page looks exactly like "no matches" — the wrong answer.
    const p = paginate(many, 99, 10);
    expect(p.page).toBe(5);
    expect(p.items).toHaveLength(7);
  });

  it("clamps a page below one", () => {
    expect(paginate(many, 0, 10).page).toBe(1);
    expect(paginate(many, -5, 10).page).toBe(1);
  });

  it("reports one page for an empty list rather than zero", () => {
    // pages=0 would make "Page 1 of 0" and break every hasNext/hasPrev guard.
    const p = paginate([], 1, 10);
    expect(p.pages).toBe(1);
    expect(p.total).toBe(0);
    expect(p.hasNext).toBe(false);
  });

  it("never divides by a zero page size", () => {
    expect(paginate(many, 1, 0).perPage).toBe(1);
    expect(paginate(many, 1, 0).pages).toBe(47);
  });
});

describe("filter then page", () => {
  it("pages the filtered list, not the original", () => {
    const list = Array.from({ length: 30 }, (_, i) => ({
      name: i % 3 === 0 ? `keep ${i}` : `drop ${i}`,
      status: "active",
    }));
    const res = filterAndPaginate(list, query({ q: "keep" }), { fields: (i) => [i.name] }, 4);
    expect(res.total).toBe(10);
    expect(res.pages).toBe(3);
    expect(res.items).toHaveLength(4);
    expect(res.items.every((i) => i.name.startsWith("keep"))).toBe(true);
    // The full filtered list is handed back too, for a caller that needs counts.
    expect(res.filtered).toHaveLength(10);
  });
});

describe("when a filter is worth showing", () => {
  it("stays hidden on a list short enough to just read", () => {
    expect(needsFilter(FILTER_THRESHOLD)).toBe(false);
    expect(needsFilter(0)).toBe(false);
    expect(needsFilter(FILTER_THRESHOLD + 1)).toBe(true);
    expect(needsFilter(465)).toBe(true);
  });
});
