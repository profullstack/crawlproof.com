import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// scan_prospects has to be honoured at every point the runner researches a
// prospect, not just the obvious one. It was originally threaded through the
// stage-3 call only, so the discovery top-up — the path that sees every newly
// discovered domain — went on scanning everything a campaign found, which is
// precisely the behaviour the setting exists to stop.
//
// Asserted against the source because the alternative is standing up the
// whole runner with a live database and a scan worker to observe a call that
// should not happen.

const RUNNER = path.join(process.cwd(), "lib/outreach/runner.ts");

describe("campaign runner honours scan_prospects", () => {
  const source = readFileSync(RUNNER, "utf8");

  // Every researchProspect({...}) call in the runner.
  const calls = [...source.matchAll(/researchProspect\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);

  it("researches prospects in more than one place", () => {
    // If this drops to one, the test below stops proving anything.
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("passes skipScan at every research call site", () => {
    const missing = calls.filter((body) => !body.includes("skipScan"));
    expect(
      missing,
      `researchProspect call(s) without skipScan — a campaign with scanning off would still scan:\n${missing.join("\n---\n")}`,
    ).toHaveLength(0);
  });

  it("derives skipScan from the campaign setting rather than hardcoding it", () => {
    for (const body of calls) {
      expect(body).toMatch(/skipScan:\s*!campaign\.scan_prospects/);
    }
  });
});
