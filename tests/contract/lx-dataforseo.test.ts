import { describe, it, expect } from "vitest";
import { filterOutliers, type DfsKeywordRow } from "@/lib/lx/dataforseo";

function row(overrides: Partial<DfsKeywordRow>): DfsKeywordRow {
  return {
    keyword: "threat detection",
    search_volume: 1000,
    competition: "LOW",
    competition_index: 11,
    cpc: 5,
    low_top_of_page_bid: null,
    high_top_of_page_bid: null,
    monthly_searches: null,
    ...overrides,
  };
}

describe("filterOutliers", () => {
  it("keeps a normal-looking row", () => {
    const r = row({});
    expect(filterOutliers([r])).toHaveLength(1);
  });

  it("drops implausible volume + very-low competition (PRD §15.1a)", () => {
    // Example from the PRD: 1M searches/mo, competition_index=1.
    const junk = row({
      keyword: "intrusion prevention service",
      search_volume: 1_000_000,
      competition_index: 1,
      cpc: 1.76,
    });
    expect(filterOutliers([junk])).toHaveLength(0);
  });

  it("drops very-low CPC paired with very-high volume", () => {
    const junk = row({
      keyword: "free vpn",
      search_volume: 80_000,
      competition_index: 50,
      cpc: 0.2,
    });
    expect(filterOutliers([junk])).toHaveLength(0);
  });

  it("drops absurdly long keywords", () => {
    const junk = row({ keyword: "a".repeat(81) });
    expect(filterOutliers([junk])).toHaveLength(0);
  });

  it("drops URL-like keywords", () => {
    const junk = row({ keyword: "see https://example.com" });
    expect(filterOutliers([junk])).toHaveLength(0);
  });

  it("keeps high-volume rows with normal competition", () => {
    // 100k volume with mid competition is plausible — not an outlier.
    const r = row({ search_volume: 100_000, competition_index: 40, cpc: 4 });
    expect(filterOutliers([r])).toHaveLength(1);
  });
});
