// The same bug on every other blog, pinned.
//
// The peptide articles were what got noticed, but pulling the real
// lx_keyword rows for all seventeen active sites showed the unanchored gate
// producing wholesale garbage everywhere. Every string below was actually in
// the queue or already published on the site named.
//
// Read the "rejects" lists as the specification: these are the searches a
// keyword tool returns when you hand it a bare subject and ask for related
// terms, and no amount of ranking distinguishes them from a real topic.
// Only the second half of the gate does.

import { describe, expect, it } from "vitest";
import {
  anchorTokens,
  isOnNiche,
  resolveMasters,
  resolveModifiers,
} from "@/lib/lx/topicPlan";

type Case = {
  domain: string;
  site: {
    master_keywords: string[];
    modifiers: string[];
    niche: string;
  };
  /** [keyword, the subject it was researched for] */
  rejects: Array<[string, string]>;
  keeps: Array<[string, string]>;
};

const CASES: Case[] = [
  {
    // Home-alarm installers on a CI/CD supply-chain security blog. This is the
    // case that forced anchors to exclude subject words: "security" is both a
    // subject word and a niche word, so before that fix "adt home security"
    // satisfied both halves of the gate using the single token "security".
    domain: "vu1nz.com",
    site: {
      master_keywords: [
        "ci/cd security", "supply chain security", "github actions security",
        "devops security", "npm security",
      ],
      modifiers: [],
      niche: "CI/CD and supply chain security",
    },
    rejects: [
      ["adt home security", "devops security"],
      ["brinks home security", "devops security"],
      ["vivint security", "devops security"],
      ["security public storage", "devops security"],
      ["security dodge", "devops security"],
      ["safe haven security", "devops security"],
      ["security clearance", "devops security"],
      ["weiser security", "devops security"],
    ],
    keeps: [
      ["npm security best practices", "npm security"],
      ["github actions security checklist", "github actions security"],
      ["supply chain security tools", "supply chain security"],
    ],
  },
  {
    // Pregnancy-test evaporation lines and a Roblox game, on a SOC blog.
    domain: "threatcrush.com",
    site: {
      master_keywords: [
        "security operations", "threat detection", "incident response",
        "soc tools", "detection engineering", "network security monitoring",
      ],
      modifiers: [],
      niche: "security operations and threat detection",
    },
    rejects: [
      ["evap line first response", "incident response"],
      ["first response evap line", "incident response"],
      ["emergency response liberty county", "incident response"],
      ["911 live incident", "incident response"],
      ["community emergency response team", "incident response"],
      ["personal emergency response system", "incident response"],
    ],
    keeps: [
      ["incident response platform", "incident response"],
      ["soc tools comparison", "soc tools"],
      ["threat detection software", "threat detection"],
    ],
  },
  {
    // TV remotes and a lawn mower, on screen-sharing software.
    domain: "pairux.com",
    site: {
      master_keywords: [
        "screen sharing", "remote desktop", "remote collaboration",
        "remote control", "video conferencing", "pair programming",
      ],
      modifiers: [],
      niche: "collaborative screen sharing software",
    },
    rejects: [
      ["samsung tv remote", "remote control"],
      ["vizio tv remote", "remote control"],
      ["roku voice remote", "remote control"],
      ["garage door opener remote", "remote control"],
      ["remote control lawn mower", "remote control"],
      ["firestick remote", "remote control"],
      ["universal remote", "remote control"],
    ],
    keeps: [
      ["screen sharing software for remote teams", "screen sharing"],
      ["remote desktop software", "remote desktop"],
    ],
  },
  {
    // Publicly traded companies, on a torrent-streaming blog.
    domain: "bittorrented.com",
    site: {
      master_keywords: [
        "streaming", "torrents", "iptv", "media tech", "vpn", "cord cutting",
      ],
      modifiers: [],
      niche: "streaming torrent media tech",
    },
    rejects: [
      ["tyler technologies", "media tech"],
      ["lumen technologies", "media tech"],
      ["micron technology", "media tech"],
      ["palantir technologies", "media tech"],
      ["trane technologies", "media tech"],
      ["applied industrial technologies", "media tech"],
      ["wake tech", "media tech"],
      ["lanier tech", "media tech"],
    ],
    keeps: [["streaming media software", "streaming"]],
  },
  {
    // Numerical optimization and a dog breed, on an AEO blog. "xoloitzcuintli
    // price" was genuinely queued.
    domain: "crawlproof.com",
    site: {
      master_keywords: [
        "answer engine optimization", "AEO", "LLM crawlers",
        "AI answer engines", "schema markup",
      ],
      modifiers: [],
      niche: "answer engine optimization for websites",
    },
    rejects: [
      ["bayesian optimization", "answer engine optimization"],
      ["convex optimization", "answer engine optimization"],
      ["scipy optimization minimize", "answer engine optimization"],
      ["ant colony optimization algorithms", "answer engine optimization"],
      ["topology optimization", "answer engine optimization"],
      ["charles babbage analytical engine", "answer engine optimization"],
      ["matlab optimization toolbox", "answer engine optimization"],
    ],
    keeps: [["answer engine optimization for websites", "answer engine optimization"]],
  },
  {
    // Hardware tool brands and biochemistry, on an AI-agent-standards blog.
    domain: "logicsrc.com",
    site: {
      master_keywords: [
        "ai agents", "agent orchestration", "developer tools",
        "api integration", "open standards", "mcp",
      ],
      modifiers: [],
      niche: "open AI agent standards",
    },
    rejects: [
      ["mac tools", "developer tools"],
      ["metabo tools", "developer tools"],
      ["jb tools", "developer tools"],
      ["osint tools", "developer tools"],
      ["intercalating agent", "ai agents"],
      ["causative agent", "ai agents"],
      ["principal agent problem", "ai agents"],
    ],
    keeps: [["agent orchestration platform", "agent orchestration"]],
  },
];

describe.each(CASES)("$domain", ({ site, rejects, keeps }) => {
  const masters = resolveMasters(site);
  const anchors = anchorTokens(site, masters);

  it("resolves an anchor set, so the site is never researched unanchored", () => {
    expect(resolveModifiers(site, masters).length).toBeGreaterThan(0);
    expect(anchors.size).toBeGreaterThan(0);
  });

  it("shares no token between the anchors and the subjects", () => {
    // The invariant that makes the two halves of the gate independent.
    const masterTokens = new Set(
      masters.flatMap((m) => m.toLowerCase().split(/[^a-z0-9]+/i)),
    );
    for (const anchor of anchors) {
      expect(masterTokens.has(anchor)).toBe(false);
    }
  });

  it.each(rejects)("rejects %j", (keyword, master) => {
    expect(isOnNiche(keyword, master, anchors)).toBe(false);
  });

  it.each(keeps)("keeps %j", (keyword, master) => {
    expect(isOnNiche(keyword, master, anchors)).toBe(true);
  });
});
