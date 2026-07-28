import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Discovery must not accumulate a per-industry blacklist.
//
// It nearly did: a run aimed at 3D artists produced art schools, Blender
// forums and CG trade press, and the obvious fix was to name them. That works
// for exactly one campaign. The community hubs for dentists, accountants or
// plumbers have nothing in common with those, so a named list is both endless
// and stale the moment someone points a campaign at a niche nobody
// anticipated.
//
// Filtering therefore has to be decided from the shape of a hostname, or from
// whether a contact can actually be found — never from knowing an industry.
// This test is the thing that notices when that erodes.

const DISCOVER = path.join(process.cwd(), "lib/outreach/discover.ts");

/** Hosts from one real campaign's results. None belongs in the source. */
const NICHE_HOSTS = [
  "blenderartists.org",
  "polycount.com",
  "cgsociety.org",
  "therookies.co",
  "80.lv",
  "cgchannel.com",
  "gamedeveloper.com",
  "wingfox.com",
  "vanarts.com",
  "cgspectrum.com",
  "thinktankonline.com",
  "animationmentor.com",
  "artstation.com",
  "behance.net",
  "sketchfab.com",
  "cgtrader.com",
  "turbosquid.com",
  "unrealengine.com",
  "blender.org",
  "autodesk.com",
];

describe("discovery carries no industry-specific hostnames", () => {
  const source = readFileSync(DISCOVER, "utf8");

  for (const host of NICHE_HOSTS) {
    it(`does not name ${host}`, () => {
      expect(
        source.includes(host),
        `${host} is hardcoded in discover.ts. Filtering has to work for any niche — decide it from the hostname's shape, or from whether a contact can be found.`,
      ).toBe(false);
    });
  }

  it("also keeps industry words out of the patterns", () => {
    // "academy" and "portfolio" are one industry's vocabulary; "forum" and
    // "wiki" describe what a page is in any of them.
    for (const word of ["academy", "portfolio", "artist", "3d", "gaming"]) {
      expect(
        source.toLowerCase().includes(`|${word}`),
        `"${word}" reads like industry vocabulary in a filter pattern`,
      ).toBe(false);
    }
  });
});
