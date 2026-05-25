import { describe, it, expect } from "vitest";
import {
  crossSeeds,
  suggestTopics,
  rankPartners,
} from "@/lib/lx/guestPostMatcher";

describe("crossSeeds", () => {
  it("produces the cartesian product as lowercased phrases", () => {
    const out = crossSeeds(["AEO", "schema"], ["SOC", "threat intel"]);
    expect(out).toContain("aeo soc");
    expect(out).toContain("aeo threat intel");
    expect(out).toContain("schema soc");
    expect(out).toContain("schema threat intel");
  });

  it("dedupes", () => {
    const out = crossSeeds(["x"], ["y", "y"]);
    expect(out).toEqual(["x y"]);
  });

  it("skips token-subset pairs to avoid 'payments crypto payments'", () => {
    expect(crossSeeds(["crypto payments"], ["payments"])).toEqual([]);
    expect(crossSeeds(["payments"], ["crypto payments"])).toEqual([]);
  });

  it("drops empty / whitespace-only entries", () => {
    expect(crossSeeds(["a", "", "  "], ["b"])).toEqual(["a b"]);
  });

  it("caps phrase length", () => {
    const long = "x".repeat(40);
    const longer = "y".repeat(40);
    expect(crossSeeds([long], [longer])).toEqual([]);
  });
});

describe("suggestTopics", () => {
  const author = {
    id: "self",
    niche: "answer engine optimization for websites",
    target_audiences: ["technical founders", "SEO leads"],
    seed_keywords: ["AEO", "schema markup", "GPTBot"],
    modifiers: ["for B2B", "in 2026"],
  };

  it("returns a non-empty cross when both sides have seeds", () => {
    const out = suggestTopics(author, {
      niche: "security operations and threat intelligence",
      seed_keywords: ["SOC", "threat intel", "SIEM"],
      modifiers: ["for enterprise"],
      target_audiences: ["security engineers"],
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it("phrases include tokens from both sides — genuine bridges", () => {
    const out = suggestTopics(author, {
      niche: "crypto payments",
      seed_keywords: ["crypto", "checkout", "stablecoin"],
      modifiers: [],
      target_audiences: ["payments engineers"],
    });
    // Every suggestion should contain at least one author-side token AND
    // at least one partner-side token.
    const authorTokens = ["aeo", "schema", "markup", "gptbot", "answer", "engine"];
    const partnerTokens = ["crypto", "checkout", "stablecoin", "payments"];
    for (const phrase of out) {
      const hasAuthor = authorTokens.some((t) => phrase.includes(t));
      const hasPartner = partnerTokens.some((t) => phrase.includes(t));
      expect(hasAuthor, `phrase "${phrase}" missing author token`).toBe(true);
      expect(hasPartner, `phrase "${phrase}" missing partner token`).toBe(true);
    }
  });

  it("returns [] when both sides are empty", () => {
    const out = suggestTopics(
      { id: "self", niche: null, target_audiences: [], seed_keywords: [], modifiers: [] },
      { niche: null, seed_keywords: [], modifiers: [], target_audiences: [] },
    );
    expect(out).toEqual([]);
  });
});

const PARTNER_FIXTURES = [
  {
    id: "p-sec",
    domain: "threatcrush.com",
    niche: "security operations and threat intelligence",
    blog_root_url: "https://threatcrush.com/blog",
    target_audiences: ["SOC teams"],
    seed_keywords: ["SOC", "threat intel"],
    modifiers: [],
    status: "active",
    backlinks_enabled: true,
    inappropriate_content: false,
  },
  {
    id: "p-pay",
    domain: "coinpayportal.com",
    niche: "crypto payments and merchant tooling",
    blog_root_url: "https://coinpayportal.com/blog",
    target_audiences: ["merchants"],
    seed_keywords: ["crypto checkout", "stablecoin"],
    modifiers: [],
    status: "active",
    backlinks_enabled: true,
    inappropriate_content: false,
  },
  {
    id: "p-paused",
    domain: "paused.example.com",
    niche: "security operations",
    blog_root_url: "https://paused.example.com/blog",
    target_audiences: [],
    seed_keywords: ["SOC"],
    modifiers: [],
    status: "paused",
    backlinks_enabled: true,
    inappropriate_content: false,
  },
  {
    id: "p-noopt",
    domain: "noopt.example.com",
    niche: "security operations",
    blog_root_url: "https://noopt.example.com/blog",
    target_audiences: [],
    seed_keywords: ["SOC"],
    modifiers: [],
    status: "active",
    backlinks_enabled: false,
    inappropriate_content: false,
  },
];

describe("rankPartners", () => {
  const author = {
    id: "self",
    niche: "security operations and threat intelligence",
    target_audiences: ["security engineers"],
    seed_keywords: ["SOC", "threat intel"],
    modifiers: [],
  };

  it("ranks the topically-matching partner highest", () => {
    const out = rankPartners(author, PARTNER_FIXTURES);
    expect(out[0].partner.id).toBe("p-sec");
  });

  it("filters out paused and opt-out sites", () => {
    const ids = new Set(rankPartners(author, PARTNER_FIXTURES).map((r) => r.partner.id));
    expect(ids.has("p-paused")).toBe(false);
    expect(ids.has("p-noopt")).toBe(false);
  });

  it("excludes self", () => {
    const withSelf = [
      {
        ...PARTNER_FIXTURES[0],
        id: author.id, // pretend self also matches
      },
      ...PARTNER_FIXTURES,
    ];
    const ids = rankPartners(author, withSelf).map((r) => r.partner.id);
    expect(ids).not.toContain(author.id);
  });

  it("strict mode drops zero-overlap partners (default minScore=1)", () => {
    const lonelyAuthor = {
      id: "self",
      niche: "freelancing and gig work",
      target_audiences: [],
      seed_keywords: ["freelance"],
      modifiers: [],
    };
    expect(rankPartners(lonelyAuthor, PARTNER_FIXTURES)).toEqual([]);
  });

  it("relaxed mode (minScore=0) surfaces zero-overlap partners", () => {
    const lonelyAuthor = {
      id: "self",
      niche: "freelancing and gig work",
      target_audiences: [],
      seed_keywords: ["freelance"],
      modifiers: [],
    };
    const out = rankPartners(lonelyAuthor, PARTNER_FIXTURES, { minScore: 0 });
    expect(out.length).toBeGreaterThan(0);
  });
});
