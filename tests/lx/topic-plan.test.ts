// The peptide regression, pinned.
//
// Every fixture here is real: the master list, the modifiers and the niche are
// coinpayportal.com's live values, and the rejected keywords are titles the
// site actually published in June and July 2026. If these pass, the specific
// nineteen articles that prompted this work cannot be generated again.

import { describe, expect, it } from "vitest";
import {
  allocate,
  DEFAULT_MODIFIERS,
  anchorTokens,
  crossQueries,
  dropDuplicates,
  isOnNiche,
  MAX_MASTERS,
  resolveMasters,
  resolveModifiers,
  signature,
  stem,
} from "@/lib/lx/topicPlan";

// coinpayportal.com, exactly as stored.
const SITE = {
  master_keywords: [
    "peptide", "crypto", "blockchain", "cryptocurrency", "casino",
    "marijuana", "dispensary", "weed", "iptv", "torrents",
  ],
  seed_keywords: [
    "peptide", "crypto", "blockchain", "cryptocurrency", "casino",
    "marijuana", "dispensary", "weed", "iptv", "torrents",
  ],
  modifiers: [
    "payments", "transactions", "merchant account",
    "payment gateway", "payment processing",
  ],
  niche: "crypto payments for high-risk merchants",
};

describe("resolveMasters", () => {
  it("keeps every subject — the truncation that caused the outage is gone", () => {
    // The old buildSeeds() ended in .slice(0, 5) and the expansion loop then
    // took .slice(0, 3). marijuana, dispensary, weed, iptv and torrents had
    // never produced a single keyword in the site's lifetime.
    const masters = resolveMasters(SITE);
    expect(masters).toHaveLength(10);
    for (const forgotten of ["marijuana", "dispensary", "weed", "iptv", "torrents"]) {
      expect(masters).toContain(forgotten);
    }
  });

  it("falls back to seed_keywords so it is safe to deploy before the backfill", () => {
    expect(resolveMasters({ seed_keywords: ["alpha", "beta"] })).toEqual(["alpha", "beta"]);
  });

  it("caps an oversized list rather than rejecting it", () => {
    const many = Array.from({ length: 40 }, (_, i) => `subject${i}`);
    expect(resolveMasters({ master_keywords: many })).toHaveLength(MAX_MASTERS);
  });

  it("drops duplicates and blanks without shifting the rest", () => {
    expect(resolveMasters({ master_keywords: ["crypto", " ", "Crypto", "casino"] }))
      .toEqual(["crypto", "casino"]);
  });
});

describe("resolveModifiers", () => {
  it("prefers the explicit column", () => {
    expect(resolveModifiers(SITE, resolveMasters(SITE))).toContain("merchant account");
  });

  it("mines the niche when the column is empty — 13 of 17 live sites", () => {
    const derived = resolveModifiers(
      { modifiers: [], niche: "security operations and threat detection" },
      ["siem", "edr"],
    );
    expect(derived).toEqual(
      expect.arrayContaining(["security", "operations", "threat", "detection"]),
    );
    // "and" carries no narrowing and would weaken the gate.
    expect(derived).not.toContain("and");
  });

  it("subtracts the subjects from the niche-derived terms", () => {
    // vu1nz.com: niche "CI/CD and supply chain security" says nothing its
    // own subjects do not already say. A term that is also a subject cannot
    // narrow anything, and keeping it is what admits "adt home security".
    const derived = resolveModifiers(
      { modifiers: [], niche: "CI/CD and supply chain security" },
      ["ci/cd security", "supply chain security", "devops security"],
    );
    expect(derived).not.toContain("security");
    expect(derived).not.toContain("supply");
  });

  it("falls back to the commercial vocabulary when the niche adds nothing", () => {
    const derived = resolveModifiers(
      { modifiers: [], niche: "CI/CD and supply chain security" },
      ["ci/cd security", "supply chain security", "devops security"],
    );
    expect(derived).toBe(DEFAULT_MODIFIERS);
  });
});

describe("isOnNiche — the gate that was missing", () => {
  const anchors = anchorTokens(SITE, resolveMasters(SITE));

  // These are real published titles. Each is a peptide *vendor* — a
  // competitor storefront in an industry coinpayportal sells payment
  // processing TO, not one it writes about.
  it.each([
    "skye peptides",
    "pure peptide labs",
    "wolverine stack peptides",
    "apex peptides",
    "biotech peptides",
    "melanotan 2 peptides",
    "ghk peptide",
    "aod 9604 peptide",
    "peptide crafters",
    "lab 34 peptides and proteins",
  ])("rejects the vendor term %j", (keyword) => {
    expect(isOnNiche(keyword, "peptide", anchors)).toBe(false);
  });

  // These are the May 2026 posts — the period before the regression, when
  // the pipeline still crossed seeds with modifiers.
  it.each([
    "peptide merchant account",
    "peptide payment processing",
    "peptide payment gateway",
    "peptide payments",
    "peptide transactions",
  ])("keeps the on-niche keyword %j", (keyword) => {
    expect(isOnNiche(keyword, "peptide", anchors)).toBe(true);
  });

  it("requires the subject as well as the anchor", () => {
    // Anchored, but about a subject this blog does not cover.
    expect(isOnNiche("plumbing merchant account", "peptide", anchors)).toBe(false);
  });

  it("refuses everything when a site has no anchor at all", () => {
    // Defaulting to "allow" here would restore the exact behaviour that
    // published the vendor articles, so an anchorless site must fail closed
    // and let the caller raise it.
    expect(isOnNiche("peptide merchant account", "peptide", new Set())).toBe(false);
  });
});

describe("crossQueries", () => {
  const crosses = crossQueries(
    resolveMasters(SITE),
    resolveModifiers(SITE, resolveMasters(SITE)),
    3,
  );

  it("gives every subject coverage, including the five that never had any", () => {
    const covered = new Set(crosses.map((c) => c.master));
    expect(covered.size).toBe(10);
    for (const forgotten of ["marijuana", "dispensary", "weed", "iptv", "torrents"]) {
      expect(covered.has(forgotten)).toBe(true);
    }
  });

  it("never emits a bare subject — that is what returned the vendor terms", () => {
    for (const { master, query } of crosses) {
      expect(query).not.toBe(master);
      expect(query.length).toBeGreaterThan(master.length);
    }
  });

  it("orders subject-major so a truncated run loses depth, not coverage", () => {
    // The first ten entries must be ten *different* subjects: a budget cut
    // partway through should still have touched everything.
    const firstPass = crosses.slice(0, 10).map((c) => c.master);
    expect(new Set(firstPass).size).toBe(10);
  });

  it("skips a cross whose modifier is already in the subject", () => {
    const out = crossQueries(["crypto"], ["crypto", "payments"], 2);
    expect(out.map((c) => c.query)).not.toContain("crypto crypto");
    expect(out.map((c) => c.query)).toContain("crypto payments");
  });

  it("produces nothing without modifiers, rather than expanding bare", () => {
    expect(crossQueries(["peptide"], [], 3)).toEqual([]);
  });
});

describe("allocate", () => {
  it("fills the subjects that are behind first", () => {
    // The live skew: 23 peptide articles, 11 crypto, nothing else.
    const coverage = new Map([["peptide", 23], ["crypto", 11]]);
    const out = allocate(resolveMasters(SITE), coverage, 30);

    expect(out.get("peptide") ?? 0).toBe(0);
    expect(out.get("crypto") ?? 0).toBe(0);
    // Everything with no history gets a share.
    for (const starved of ["marijuana", "dispensary", "weed", "iptv", "torrents"]) {
      expect(out.get(starved) ?? 0).toBeGreaterThan(0);
    }
  });

  it("splits evenly when nothing has history", () => {
    const out = allocate(["a", "b", "c"], new Map(), 30);
    expect([out.get("a"), out.get("b"), out.get("c")]).toEqual([10, 10, 10]);
  });

  it("allocates exactly the target", () => {
    const masters = resolveMasters(SITE);
    const total = Array.from(allocate(masters, new Map(), 30).values())
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(30);
  });

  it("is a no-op for an empty subject list", () => {
    expect(allocate([], new Map(), 30).size).toBe(0);
  });
});

describe("stem — plural collapsing", () => {
  // The subtle one. An earlier version stripped two characters from every
  // "-es", so "codes" became "cod" while "code" stayed "code" and the two
  // never matched. That silently broke plural matching everywhere, and made
  // several of the peptide rejections above pass for the wrong reason:
  // "skye peptides" was rejected because "peptides" stemmed to "peptid" and
  // failed to match the subject at all, not because it lacked an anchor.
  it.each([
    ["codes", "code"],
    ["peptides", "peptide"],
    ["payments", "payment"],
    ["alternatives", "alternative"],
    ["practices", "practice"],
    ["transactions", "transaction"],
  ])("collapses %j onto %j", (plural, singular) => {
    expect(stem(plural)).toBe(stem(singular));
  });

  it.each([
    ["boxes", "box"],
    ["matches", "match"],
    ["searches", "search"],
  ])("still strips the epenthetic e in %j", (plural, singular) => {
    expect(stem(plural)).toBe(stem(singular));
  });

  it("handles -ies", () => {
    expect(stem("companies")).toBe(stem("company"));
  });

  it("leaves a short word alone rather than mangling it", () => {
    // "aeo" and "soc" must not lose characters they cannot spare.
    expect(stem("aeo")).toBe("aeo");
    expect(stem("gas")).toBe("gas");
  });
});

describe("signature + dropDuplicates", () => {
  it("collapses the plural restatement that shipped twice", () => {
    // Both published, nine days apart, in May 2026.
    expect(signature("peptide payments")).toBe(signature("peptide payment"));
  });

  it("collapses a reordering", () => {
    expect(signature("merchant account peptide")).toBe(signature("peptide merchant account"));
  });

  it("keeps genuinely different subjects apart", () => {
    expect(signature("peptide payments")).not.toBe(signature("casino payments"));
  });

  it("drops candidates already on the blog", () => {
    const published = new Set([signature("peptide payments")]);
    const out = dropDuplicates(
      [{ keyword: "peptide payment" }, { keyword: "casino payments" }],
      published,
    );
    expect(out.map((c) => c.keyword)).toEqual(["casino payments"]);
  });

  it("drops duplicates within the candidate list itself", () => {
    const out = dropDuplicates(
      [{ keyword: "iptv payments" }, { keyword: "iptv payment" }],
      new Set(),
    );
    expect(out).toHaveLength(1);
  });
});
