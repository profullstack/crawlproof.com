import { describe, expect, it } from "vitest";
import {
  filterTerms,
  matchesTerms,
  matchingIds,
  type FilterItem,
} from "@/lib/list-filter";

// Shaped like what the dashboard pages pass: the row's name, url and status
// joined into one haystack.
const ITEMS: FilterItem[] = [
  { id: "p1", text: "Shop https://shop.example.com daily active" },
  { id: "p2", text: "Blog https://blog.example.com weekly paused" },
  { id: "p3", text: "Docs https://docs.other.dev daily active autoblog" },
];

describe("filterTerms", () => {
  it("lowercases and drops empty runs of whitespace", () => {
    expect(filterTerms("  Shop   Daily ")).toEqual(["shop", "daily"]);
  });

  it("is empty for a blank query, which matches everything", () => {
    expect(filterTerms("   ")).toEqual([]);
    expect(matchesTerms("anything", [])).toBe(true);
  });
});

describe("matchesTerms", () => {
  it("matches case-insensitive substrings", () => {
    expect(matchesTerms("Shop https://shop.example.com", ["SHOP"])).toBe(true);
    expect(matchesTerms("Shop", ["sho"])).toBe(true);
    expect(matchesTerms("Shop", ["shopping"])).toBe(false);
  });

  it("requires every term, in any order", () => {
    const text = "Blog https://blog.example.com weekly paused";
    expect(matchesTerms(text, ["blog", "paused"])).toBe(true);
    expect(matchesTerms(text, ["paused", "blog"])).toBe(true);
    expect(matchesTerms(text, ["blog", "daily"])).toBe(false);
  });
});

describe("matchingIds", () => {
  it("returns null for an empty query rather than every id", () => {
    expect(matchingIds(ITEMS, "")).toBeNull();
    expect(matchingIds(ITEMS, "  ")).toBeNull();
  });

  it("narrows on name, url or status", () => {
    expect(matchingIds(ITEMS, "shop")).toEqual(new Set(["p1"]));
    expect(matchingIds(ITEMS, "example.com")).toEqual(new Set(["p1", "p2"]));
    expect(matchingIds(ITEMS, "paused")).toEqual(new Set(["p2"]));
    expect(matchingIds(ITEMS, "daily")).toEqual(new Set(["p1", "p3"]));
  });

  it("ANDs terms from different parts of the row", () => {
    expect(matchingIds(ITEMS, "daily autoblog")).toEqual(new Set(["p3"]));
  });

  it("returns an empty set when nothing matches, which is not null", () => {
    const result = matchingIds(ITEMS, "nothing-here");
    expect(result).toEqual(new Set());
    expect(result).not.toBeNull();
  });
});
