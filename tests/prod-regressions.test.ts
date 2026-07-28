import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { separateUrlPunctuation, unsupportedCustomClaims, urlsIn } from "@/lib/outreach/cold";

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

describe("a link ends where the URL characters end", () => {
  const guard = unsupportedCustomClaims;
  const declared = ["download it at https://threatcrush.com/get-whitepaper"];

  it("does not swallow the punctuation jammed against it", () => {
    // The live draft read "...get-whitepaper—download..." and the guard read
    // the em-dash and the next word as part of the URL, then rejected the
    // draft for linking somewhere the campaign never mentioned.
    expect(urlsIn("grab it at https://threatcrush.com/get-whitepaper—download now")).toEqual([
      "https://threatcrush.com/get-whitepaper",
    ]);
  });

  it("accepts that draft instead of rejecting it", () => {
    const body = "Grab it at https://threatcrush.com/get-whitepaper—download takes a minute.";
    expect(guard(body, declared)).toEqual([]);
  });

  it("still strips ordinary sentence punctuation", () => {
    expect(urlsIn("see https://x.test/a.")).toEqual(["https://x.test/a"]);
    expect(urlsIn("see (https://x.test/a), then")).toEqual(["https://x.test/a"]);
  });

  it("keeps punctuation that is genuinely part of the path", () => {
    expect(urlsIn("see https://x.test/a_b-c~d/e?f=1&g=2#h then")).toEqual([
      "https://x.test/a_b-c~d/e?f=1&g=2#h",
    ]);
  });

  it("separates the dash so no mail client can autolink it", () => {
    // Even with the check corrected, a URL welded to an em-dash is a link
    // some clients will autolink including the dash — a 404 on the one thing
    // the email asked the recipient to click.
    expect(separateUrlPunctuation("at https://x.test/p—download now")).toBe(
      "at https://x.test/p —download now",
    );
  });

  it("leaves a well-formed sentence untouched", () => {
    const clean = "Grab it at https://x.test/p. It takes a minute.";
    expect(separateUrlPunctuation(clean)).toBe(clean);
  });

  it("still catches a genuinely invented link", () => {
    expect(guard("see https://not-declared.test/x", declared).join(" ")).toMatch(/links to/);
  });
});
