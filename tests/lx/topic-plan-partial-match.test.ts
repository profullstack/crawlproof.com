// What leaked on the first production run, pinned.
//
// The anchored gate shipped and killed the vendor/junk classes outright. The
// hourly cron then wrote 162 keywords across 11 sites, and eight of them were
// still wrong — all of one shape, none of it visible in the fixtures that
// existed before real output could be inspected.
//
// The shape: a *partial* match on one generic word of a multi-word subject,
// rescued by a word from the generic commercial vocabulary. "open standards"
// matched on "open", "software" did the rest, and the blog was queued to write
// about OBS Studio. One generic subject word plus one generic tail word is not
// evidence of anything.

import { describe, expect, it } from "vitest";
import {
  anchorTokens,
  isOnNiche,
  ownAnchorTokens,
  resolveMasters,
} from "@/lib/lx/topicPlan";

type Case = {
  domain: string;
  site: { master_keywords: string[]; modifiers: string[]; niche: string };
  leaked: Array<[string, string]>;
  keeps: Array<[string, string]>;
};

const CASES: Case[] = [
  {
    domain: "logicsrc.com",
    site: {
      master_keywords: [
        "ai agents", "agent orchestration", "developer tools",
        "api integration", "open standards", "mcp",
      ],
      modifiers: [],
      niche: "open AI agent standards",
    },
    leaked: [
      // Both queued for real. OBS Studio, on a blog about agent standards.
      ["open broadcaster software", "open standards"],
      ["open source software", "open standards"],
    ],
    keeps: [
      // Complete subject matches, unaffected by the partial-match rule.
      ["agent orchestration tools", "agent orchestration"],
      ["ai agents platform", "ai agents"],
      ["api integration comparison", "api integration"],
    ],
  },
  {
    domain: "vu1nz.com",
    site: {
      master_keywords: [
        "ci/cd security", "supply chain security", "github actions security",
        "devops security", "npm security",
      ],
      modifiers: [],
      niche: "CI/CD and supply chain security",
    },
    leaked: [["industrial automation supply", "supply chain security"]],
    keeps: [
      ["supply chain security tools", "supply chain security"],
      ["github actions security platform", "github actions security"],
    ],
  },
  {
    domain: "c0upons.com",
    site: {
      master_keywords: [
        "coupon codes", "promo codes", "deals", "discount codes",
        "online shopping", "saving money",
      ],
      modifiers: [],
      niche: "coupon codes and savings",
    },
    leaked: [
      ["quickbooks online pricing", "online shopping"],
      ["quickbooks online simple start pricing", "online shopping"],
    ],
    keeps: [
      ["coupon codes for online shopping", "online shopping"],
      ["how to save money online shopping", "online shopping"],
    ],
  },
  {
    domain: "ugig.net",
    site: {
      master_keywords: [
        "freelancing", "gig economy", "AI tools", "remote work", "freelance jobs",
      ],
      modifiers: [],
      niche: "AI-assisted freelancing and gig work",
    },
    leaked: [
      ["software engineer remote", "remote work"],
      ["work from home software engineer", "remote work"],
    ],
    keeps: [["ai assisted freelancing", "freelancing"]],
  },
];

describe.each(CASES)("$domain — partial-match leaks", ({ site, leaked, keeps }) => {
  const masters = resolveMasters(site);
  const anchors = anchorTokens(site, masters);
  const own = ownAnchorTokens(site, masters);

  it.each(leaked)("rejects %j", (keyword, master) => {
    expect(isOnNiche(keyword, master, anchors, own)).toBe(false);
  });

  it.each(keeps)("still keeps %j", (keyword, master) => {
    expect(isOnNiche(keyword, master, anchors, own)).toBe(true);
  });
});

describe("ownAnchorTokens", () => {
  it("excludes the generic vocabulary, which is the whole point", () => {
    const site = {
      master_keywords: ["open standards"],
      modifiers: [],
      niche: "open AI agent standards",
    };
    const own = ownAnchorTokens(site, resolveMasters(site));
    // "software" and "pricing" are commercial-generic; they may complete a
    // FULL subject match but must not rescue a partial one.
    expect(own.has("software")).toBe(false);
    expect(own.has("pricing")).toBe(false);
  });

  it("keeps a site's explicit modifiers", () => {
    const site = {
      master_keywords: ["peptide"],
      modifiers: ["merchant account", "payment gateway"],
      niche: "crypto payments for high-risk merchants",
    };
    const own = ownAnchorTokens(site, resolveMasters(site));
    expect(own.has("merchant")).toBe(true);
    expect(own.has("gateway")).toBe(true);
  });
});

describe("a complete subject match is still exempt", () => {
  // Single-word subjects match completely by definition, so "iptv
  // alternatives" is a real query and must survive the new rule.
  const site = {
    master_keywords: ["streaming", "torrents", "iptv", "media tech"],
    modifiers: [],
    niche: "streaming torrent media tech",
  };
  const masters = resolveMasters(site);
  const anchors = anchorTokens(site, masters);
  const own = ownAnchorTokens(site, masters);

  it.each([
    ["iptv alternatives", "iptv"],
    ["streaming media software", "streaming"],
  ])("keeps %j", (keyword, master) => {
    expect(isOnNiche(keyword, master, anchors, own)).toBe(true);
  });

  it("still rejects a partial match on the multi-word subject", () => {
    expect(isOnNiche("micron technology", "media tech", anchors, own)).toBe(false);
  });
});
