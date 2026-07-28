import { describe, it, expect } from "vitest";
import { isMineableSource, isNonProspectHost } from "@/lib/outreach/discover";

// Every host below actually came out of a live discovery run for
// "3d artist portfolio"-shaped queries. Searching for artists returns the
// industry around artists, and all of it has a contact address, so without
// filtering a campaign ends up cold-emailing an art school about a job.
describe("hosts that a portfolio search keeps returning", () => {
  const rejected = [
    // Platforms and marketplaces — a profile there is not a site they own.
    "artstation.com",
    "brainchild.artstation.com",
    "behance.net",
    "adobe.com",
    "portfolio.adobe.com",
    "sketchfab.com",
    "cgtrader.com",
    "upwork.com",
    "fiverr.com",
    // Education.
    "vanarts.com",
    "gnomon.edu",
    "someschool.ac.uk",
    "cg-academy.com",
    "3d-bootcamp.io",
    // Community, showcase and trade press.
    "blenderartists.org",
    "polycount.com",
    "therookies.co",
    "80.lv",
    "gamedeveloper.com",
    "blog.wingfox.com",
    "forums.example.com",
    "wiki.example.com",
    // Tooling vendors.
    "unrealengine.com",
    "blender.org",
    // Job boards.
    "jobs.example.com",
    "careers.example.com",
  ];

  for (const host of rejected) {
    it(`rejects ${host}`, () => {
      expect(isNonProspectHost(host)).toBe(true);
    });
  }
});

describe("hosts that are the artists themselves", () => {
  const accepted = [
    "jonathancaridia.com",
    "bengtsondesigns.com",
    "janedoe.design",
    "studio-nine.co.uk",
    "hardsurface.art",
    "m-kowalski.dev",
    // A real trap: contains "art" and "station" separately but is not the
    // platform, and must not be caught by a sloppy substring match.
    "artstationary.com",
  ];

  for (const host of accepted) {
    it(`accepts ${host}`, () => {
      expect(isNonProspectHost(host)).toBe(false);
    });
  }
});

describe("filter shape", () => {
  it("rejects junk that is not a host at all", () => {
    for (const junk of ["", "localhost", "not a host"]) {
      expect(isNonProspectHost(junk)).toBe(true);
    }
  });

  it("does not reject a domain merely for containing a keyword mid-word", () => {
    // "schooner" contains "school"; the pattern is anchored on separators so
    // an ordinary word does not cost us a real prospect.
    expect(isNonProspectHost("schoonerdesign.com")).toBe(false);
    expect(isNonProspectHost("newsomstudio.com")).toBe(false);
  });
});

describe("isMineableSource — not a prospect, still worth reading", () => {
  // A forum thread or alumni page is never someone to email, but it is where
  // artists' own sites actually appear. Discarding those results throws away
  // the best source of personal domains in the pipeline.
  const mineable = [
    "blenderartists.org",
    "polycount.com",
    "cgsociety.org",
    "therookies.co",
    "80.lv",
    "gamedeveloper.com",
    "reddit.com",
    "vanarts.com",
    "gnomon.edu",
    "someschool.ac.uk",
    "forums.example.com",
    "blog.wingfox.com",
  ];

  for (const host of mineable) {
    it(`mines ${host}`, () => {
      expect(isMineableSource(host)).toBe(true);
      // Still never a prospect: mined for links, never emailed.
      expect(isNonProspectHost(host)).toBe(true);
    });
  }

  it("does not mine marketplaces, whose links stay on their own domain", () => {
    for (const host of ["artstation.com", "behance.net", "upwork.com", "fiverr.com", "sketchfab.com"]) {
      expect(isMineableSource(host), host).toBe(false);
    }
  });

  it("does not mine tooling vendors", () => {
    for (const host of ["unrealengine.com", "blender.org", "autodesk.com"]) {
      expect(isMineableSource(host), host).toBe(false);
    }
  });

  it("does not mine an artist's own site — it is a prospect, not a source", () => {
    for (const host of ["jonathancaridia.com", "janedoe.design"]) {
      expect(isMineableSource(host), host).toBe(false);
      expect(isNonProspectHost(host), host).toBe(false);
    }
  });
});
