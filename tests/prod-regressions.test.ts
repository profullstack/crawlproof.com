import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { unsupportedCustomClaims } from "@/lib/outreach/cold";

// Three failures that only appeared once campaigns ran against real
// businesses. Each is pinned by the case that produced it.

describe("a company's own name is not an invented claim", () => {
  const campaign = ["We build websites.", "Reply if useful."];

  it("lets a draft name 4 Corner Resources", () => {
    // The guard rejected every draft to them for stating "4" — which the
    // campaign, quite correctly, had never mentioned. You cannot address the
    // company without writing its name.
    const body = "I came across 4 Corner Resources and had a thought.";
    expect(unsupportedCustomClaims(body, [...campaign, "4cornerresources.com"])).toEqual([]);
  });

  it("still catches a number that is genuinely invented", () => {
    // The guard has to keep earning its place: a fabricated credential is
    // exactly what it exists to stop reaching a stranger.
    const problems = unsupportedCustomClaims(
      "We have 30 years of experience and 500 clients.",
      [...campaign, "4cornerresources.com"],
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toMatch(/30|500/);
  });

  it("still catches an invented link", () => {
    expect(
      unsupportedCustomClaims("See https://example.com/made-up", campaign).join(" "),
    ).toMatch(/links to/);
  });
});

describe("every contact source the code emits is storable", () => {
  // A prospect whose address had to be guessed was discovered, crawled,
  // searched for, and then rejected wholesale by a check constraint that
  // predated the guess path. builtinla.com is in the run log twice.
  const cold = readFileSync(new URL("../lib/outreach/cold.ts", import.meta.url), "utf8");
  const migration = readFileSync(
    new URL("../supabase/migrations/20260729050000_prospect_contact_source_guess.sql", import.meta.url),
    "utf8",
  );

  it("the constraint covers the declared ContactCandidate sources", () => {
    const declared = cold.match(/source:\s*("(?:mailto|text|manual|guess|search)"\s*\|?\s*)+/);
    expect(declared).not.toBeNull();
    for (const source of ["mailto", "text", "manual", "guess"]) {
      expect(migration).toContain(`'${source}'`);
    }
  });
});

describe("people are output worth paying for", () => {
  // A run against a people-directory names humans without necessarily adding
  // a prospect. Leaving them out of the produced-something test refunded
  // every such run: eleven CTOs rendered, paginated, parsed — billed as zero.
  const runner = readFileSync(new URL("../lib/outreach/runner.ts", import.meta.url), "utf8");

  it("counts recorded people when deciding whether to refund", () => {
    const block = runner.slice(runner.indexOf("const producedSomething"));
    expect(block.slice(0, 300)).toContain("result.peopleRecorded");
  });

  it("still refunds a run that truly did nothing", () => {
    expect(runner).toMatch(/if \(billing\.charged\(\) && !producedSomething\)/);
  });
});
