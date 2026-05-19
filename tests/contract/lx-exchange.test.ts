import { describe, it, expect } from "vitest";
import {
  topicTokens,
  scoreOverlap,
  buildArticleUrl,
  rankExchangeCandidates,
} from "@/lib/lx/exchangeMatcher";

describe("topicTokens", () => {
  it("lowercases, splits on non-alphanum, and filters stopwords", () => {
    const t = topicTokens("Security operations AND threat intelligence");
    expect(t).toContain("security");
    expect(t).toContain("operations");
    expect(t).toContain("threat");
    expect(t).toContain("intelligence");
    expect(t.has("and")).toBe(false);
  });

  it("drops tokens shorter than 3 chars", () => {
    const t = topicTokens("AI ML ops");
    expect(t.has("ai")).toBe(false);
    expect(t.has("ml")).toBe(false);
    expect(t.has("ops")).toBe(true);
  });

  it("accepts multiple sources and unions them", () => {
    const t = topicTokens("payments", "checkout", null, undefined);
    expect(t).toContain("payments");
    expect(t).toContain("checkout");
  });

  it("returns an empty set for null / empty input", () => {
    expect(topicTokens(null, undefined, "").size).toBe(0);
  });

  it("splits on hyphens and underscores", () => {
    const t = topicTokens("AI-assisted_workflow tools");
    expect(t).toContain("assisted");
    expect(t).toContain("workflow");
    expect(t).toContain("tools");
  });
});

describe("scoreOverlap", () => {
  it("counts shared tokens", () => {
    const a = new Set(["security", "operations", "soc"]);
    const b = new Set(["security", "operations", "siem"]);
    expect(scoreOverlap(a, b)).toBe(2);
  });

  it("returns 0 when either side is empty", () => {
    expect(scoreOverlap(new Set(), new Set(["x"]))).toBe(0);
    expect(scoreOverlap(new Set(["x"]), new Set())).toBe(0);
  });

  it("returns 0 when there is no overlap", () => {
    const a = new Set(["payments", "crypto"]);
    const b = new Set(["security", "threat"]);
    expect(scoreOverlap(a, b)).toBe(0);
  });
});

describe("buildArticleUrl", () => {
  it("joins blog_root_url + slug with one slash", () => {
    expect(buildArticleUrl("https://example.com/blog", "my-post")).toBe(
      "https://example.com/blog/my-post",
    );
  });

  it("tolerates a trailing slash on blog_root_url", () => {
    expect(buildArticleUrl("https://example.com/blog/", "my-post")).toBe(
      "https://example.com/blog/my-post",
    );
  });

  it("tolerates a leading slash on slug", () => {
    expect(buildArticleUrl("https://example.com/blog", "/my-post")).toBe(
      "https://example.com/blog/my-post",
    );
  });

  it("handles root-level blogs (no path)", () => {
    expect(buildArticleUrl("https://example.com", "my-post")).toBe(
      "https://example.com/my-post",
    );
  });
});

// Shared fixture: a small pool of partner articles across niches.
const FIX = {
  selfId: "self-site-id",
  rows: [
    {
      id: "a-sec-1",
      title: "Threat intelligence pipelines for SOC teams",
      slug: "threat-intel-pipelines",
      meta_description: "Architectural patterns for SOC threat ingestion.",
      site: {
        id: "site-threatcrush",
        domain: "threatcrush.com",
        blog_root_url: "https://threatcrush.com/blog",
        niche: "security operations and threat intelligence",
      },
    },
    {
      id: "a-sec-2",
      title: "Alert triage workflows that scale",
      slug: "alert-triage",
      meta_description: "Reducing noise without dropping coverage.",
      site: {
        id: "site-threatcrush",
        domain: "threatcrush.com",
        blog_root_url: "https://threatcrush.com/blog",
        niche: "security operations and threat intelligence",
      },
    },
    {
      id: "a-pay-1",
      title: "Crypto checkout reconciliation patterns",
      slug: "crypto-recon",
      meta_description: "Settlement, retries, custody boundaries.",
      site: {
        id: "site-coinpay",
        domain: "coinpayportal.com",
        blog_root_url: "https://coinpayportal.com/blog",
        niche: "crypto payments and blockchain merchant solutions",
      },
    },
    {
      id: "a-ship-1",
      title: "Shipping software faster without breaking trust",
      slug: "ship-faster",
      meta_description: "Release cadence and rollback playbooks.",
      site: {
        id: "site-sh1pt",
        domain: "sh1pt.com",
        blog_root_url: "https://sh1pt.com/blog",
        niche: "software product launches and shipping",
      },
    },
  ],
};

describe("rankExchangeCandidates", () => {
  it("returns [] when slots is 0", () => {
    const out = rankExchangeCandidates(FIX.rows, {
      selfSiteId: FIX.selfId,
      selfNiche: "security operations",
      keyword: "soc workflow",
      slots: 0,
    });
    expect(out).toEqual([]);
  });

  it("excludes the self site", () => {
    const out = rankExchangeCandidates(FIX.rows, {
      selfSiteId: "site-threatcrush",
      selfNiche: "security operations and threat intelligence",
      keyword: "threat intelligence",
      slots: 5,
    });
    expect(out.find((c) => c.site_id === "site-threatcrush")).toBeUndefined();
  });

  it("prefers topically-overlapping candidates", () => {
    // Generating a payments post — should pull the crypto-payments article,
    // not the security or shipping ones (no shared tokens).
    const out = rankExchangeCandidates(FIX.rows, {
      selfSiteId: FIX.selfId,
      selfNiche: "payments and merchant tooling",
      keyword: "crypto checkout flows",
      slots: 3,
    });
    expect(out[0].site_id).toBe("site-coinpay");
  });

  it("returns nothing when no candidate overlaps — never falls back to off-topic", () => {
    // Generating about freelancing/gig work; no article in the fixture
    // shares tokens with that.
    const out = rankExchangeCandidates(FIX.rows, {
      selfSiteId: FIX.selfId,
      selfNiche: "AI-assisted freelancing and gig work",
      keyword: "freelancer rate cards",
      slots: 3,
    });
    expect(out).toEqual([]);
  });

  it("dedups to one candidate per giver site (spreads the love)", () => {
    // Two articles on site-threatcrush both match security keyword;
    // ranker should only return one of them.
    const out = rankExchangeCandidates(FIX.rows, {
      selfSiteId: FIX.selfId,
      selfNiche: "incident response",
      keyword: "threat intelligence SOC",
      slots: 5,
    });
    const fromThreatcrush = out.filter((c) => c.site_id === "site-threatcrush");
    expect(fromThreatcrush.length).toBe(1);
  });

  it("respects the slot cap", () => {
    const out = rankExchangeCandidates(FIX.rows, {
      selfSiteId: FIX.selfId,
      // A niche that overlaps multiple fixture sites.
      selfNiche: "security payments shipping operations",
      keyword: "engineering operations",
      slots: 2,
    });
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("returns absolute URLs built from blog_root_url + slug", () => {
    const out = rankExchangeCandidates(FIX.rows, {
      selfSiteId: FIX.selfId,
      selfNiche: "security operations",
      keyword: "threat intel",
      slots: 1,
    });
    expect(out[0].url).toMatch(/^https:\/\/threatcrush\.com\/blog\/[a-z-]+$/);
  });

  it("relaxed mode (minScore=0) surfaces candidates with zero topic overlap", () => {
    // freelancing niche has no token overlap with any fixture row.
    // Strict mode returns [] (asserted above); relaxed should return
    // something so the early-network case isn't permanently dead.
    const strict = rankExchangeCandidates(FIX.rows, {
      selfSiteId: FIX.selfId,
      selfNiche: "AI-assisted freelancing and gig work",
      keyword: "freelancer rate cards",
      slots: 3,
    });
    expect(strict).toEqual([]);

    const relaxed = rankExchangeCandidates(FIX.rows, {
      selfSiteId: FIX.selfId,
      selfNiche: "AI-assisted freelancing and gig work",
      keyword: "freelancer rate cards",
      slots: 3,
      minScore: 0,
    });
    expect(relaxed.length).toBeGreaterThan(0);
    expect(relaxed.length).toBeLessThanOrEqual(3);
  });

  it("relaxed mode still dedups by giver site and respects slot cap", () => {
    const out = rankExchangeCandidates(FIX.rows, {
      selfSiteId: FIX.selfId,
      selfNiche: "completely unrelated topic",
      keyword: "nothing in common",
      slots: 2,
      minScore: 0,
    });
    expect(out.length).toBeLessThanOrEqual(2);
    const sites = new Set(out.map((c) => c.site_id));
    expect(sites.size).toBe(out.length); // every result a distinct giver
  });

  it("relaxed mode prefers higher-scoring candidates when both have overlap and zero-overlap exist", () => {
    // payments keyword should still surface the crypto-payments article
    // first even in relaxed mode, before any zero-overlap stragglers.
    const out = rankExchangeCandidates(FIX.rows, {
      selfSiteId: FIX.selfId,
      selfNiche: "payments and merchant tooling",
      keyword: "crypto checkout flows",
      slots: 3,
      minScore: 0,
    });
    expect(out[0].site_id).toBe("site-coinpay");
  });

  it("relaxed mode tolerates an empty self-token set", () => {
    // selfNiche null + keyword that tokenizes to nothing → strict returns
    // []; relaxed should still fall back to recency-ordered candidates.
    const out = rankExchangeCandidates(FIX.rows, {
      selfSiteId: FIX.selfId,
      selfNiche: null,
      keyword: "",
      slots: 2,
      minScore: 0,
    });
    expect(out.length).toBeGreaterThan(0);
  });
});
