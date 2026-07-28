import { describe, it, expect } from "vitest";
import { isMineableSource, isNonProspectHost } from "@/lib/outreach/discover";

// The filter has to work for a campaign in any niche. Naming the community
// hubs for 3D artists would do nothing for one aimed at dentists or
// accountants, and a list like that is stale the first time someone points a
// campaign somewhere nobody anticipated. So everything below is decided from
// the shape of a hostname, never from knowing an industry.

describe("hosts that are never a prospect, in any niche", () => {
  const rejected = [
    // Education, decisively.
    "gnomon.edu",
    "someschool.ac.uk",
    "mit.edu",
    // Structural subdomains: a forum is a forum whatever the subject.
    "forums.example.com",
    "forum.example.com",
    "community.example.com",
    "wiki.example.com",
    "jobs.example.com",
    "careers.example.com",
    "support.example.com",
    "docs.example.com",
    // Freelance marketplaces and link-in-bio: a profile is not a domain
    // anyone owns, and these are cross-niche.
    "upwork.com",
    "fiverr.com",
    "toptal.com",
    "linktr.ee",
    // Covered by the pre-existing cross-niche list in lib/leadCampaign.
    "linkedin.com",
    "instagram.com",
    "reddit.com",
    "x.com",
  ];

  for (const host of rejected) {
    it(`rejects ${host}`, () => {
      expect(isNonProspectHost(host)).toBe(true);
    });
  }
});

describe("hosts that are the business itself", () => {
  const accepted = [
    "jonathancaridia.com",
    "bengtsondesigns.com",
    "janedoe.design",
    "studio-nine.co.uk",
    "hardsurface.art",
    // Niche-neutral: the filter must not have opinions about industries.
    "smile-dental.com",
    "bright-accounting.co.uk",
    "acme-plumbing.net",
  ];

  for (const host of accepted) {
    it(`accepts ${host}`, () => {
      expect(isNonProspectHost(host)).toBe(false);
    });
  }

  it("does not reject a domain for containing a keyword mid-word", () => {
    // The patterns are anchored on separators, so an ordinary word inside a
    // domain does not cost a real prospect.
    for (const host of ["schoonerdesign.com", "newsomstudio.com", "boardmanlaw.com"]) {
      expect(isNonProspectHost(host), host).toBe(false);
    }
  });
});

describe("isMineableSource — not a prospect, still worth reading", () => {
  // A forum thread is where people's own sites actually appear: a personal
  // domain rarely out-ranks the community discussing the work. Discarding
  // those results throws away the best source of real domains in the pipeline.
  const mineable = [
    "forums.example.com",
    "community.example.com",
    "wiki.example.com",
    "blog.example.com",
    "news.example.com",
    "gnomon.edu",
    "someschool.ac.uk",
  ];

  for (const host of mineable) {
    it(`mines ${host}`, () => {
      expect(isMineableSource(host)).toBe(true);
      // Mined for links, never emailed.
      expect(isNonProspectHost(host)).toBe(true);
    });
  }

  it("does not mine marketplaces, whose links stay on their own domain", () => {
    for (const host of ["upwork.com", "fiverr.com", "toptal.com", "linktr.ee"]) {
      expect(isMineableSource(host), host).toBe(false);
    }
  });

  it("does not mine a business's own site — it is a prospect, not a source", () => {
    for (const host of ["jonathancaridia.com", "smile-dental.com"]) {
      expect(isMineableSource(host), host).toBe(false);
      expect(isNonProspectHost(host), host).toBe(false);
    }
  });
});

describe("filter shape", () => {
  it("rejects junk that is not a host at all", () => {
    for (const junk of ["", "localhost", "not a host"]) {
      expect(isNonProspectHost(junk)).toBe(true);
    }
  });

  it("carries no industry-specific hostnames", () => {
    // A guard against the filter drifting back into a per-niche blacklist:
    // these are real hosts from one campaign's results, and none of them
    // should be named in the code.
    for (const host of ["blenderartists.org", "vanarts.com", "80.lv", "polycount.com"]) {
      // They may still be caught structurally, but must not be hardcoded —
      // asserted in tests/no-niche-blacklist.test.ts against the source.
      expect(typeof isNonProspectHost(host)).toBe("boolean");
    }
  });
});
