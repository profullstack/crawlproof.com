import { describe, it, expect } from "vitest";
import { unsupportedCustomClaims } from "@/lib/outreach/cold";
import { customDraftSystem } from "@/lib/outreach/pipeline";

// A job-application campaign: the case that exposed the bug, where the
// engine sent a CrawlProof audit pitch to game studios instead.
const FACTS = [
  "I am a freelance 3D modeller with 9 years of experience",
  "My portfolio is at https://nightcell7.com/work",
  "I specialise in hard-surface military assets for games",
];

describe("unsupportedCustomClaims", () => {
  it("accepts a draft that only states declared facts", () => {
    const body =
      "I'm a freelance 3D modeller specialising in hard-surface military assets, with 9 years of experience. Portfolio: https://nightcell7.com/work. Worth a look if you're hiring.";
    expect(unsupportedCustomClaims(body, FACTS)).toEqual([]);
  });

  it("catches an invented number", () => {
    const body = "I've shipped 47 titles and have 9 years of experience.";
    const problems = unsupportedCustomClaims(body, FACTS);
    expect(problems.join(" ")).toMatch(/47/);
  });

  it("does not flag a number that is in the facts", () => {
    const problems = unsupportedCustomClaims("Nine years — 9 to be exact.", FACTS);
    expect(problems.join(" ")).not.toMatch(/states "9"/);
  });

  it("catches a fabricated link", () => {
    const problems = unsupportedCustomClaims(
      "See my reel at https://vimeo.com/made-up-id for details.",
      FACTS,
    );
    expect(problems.join(" ")).toMatch(/vimeo\.com/);
  });

  it("allows the declared portfolio link", () => {
    const problems = unsupportedCustomClaims("Portfolio: https://nightcell7.com/work", FACTS);
    expect(problems).toEqual([]);
  });

  it("catches invented familiarity", () => {
    const problems = unsupportedCustomClaims("Great speaking with you last week!", FACTS);
    expect(problems.join(" ")).toMatch(/prior relationship/);
  });

  it("ignores small numbers that are ordinary prose", () => {
    expect(unsupportedCustomClaims("Just one question, and I'll keep it to 2 lines.", FACTS)).toEqual(
      [],
    );
  });

  it("does not report the same problem twice", () => {
    const problems = unsupportedCustomClaims("47 titles. 47 titles. 47 titles.", FACTS);
    expect(problems).toHaveLength(1);
  });

  it("flags everything numeric when no facts are declared", () => {
    expect(unsupportedCustomClaims("I have 12 years of experience.", []).length).toBeGreaterThan(0);
  });
});

describe("customDraftSystem", () => {
  const system = customDraftSystem({
    intro: "Anthony, a freelance 3D modeller looking for contract work",
    ask: "consider me for 3D modelling contract work",
    facts: FACTS,
  });

  it("drops the CrawlProof audit premise entirely", () => {
    expect(system).not.toMatch(/CrawlProof/);
    expect(system).not.toMatch(/answer engines/i);
    expect(system.toLowerCase()).not.toMatch(/free report/);
  });

  it("carries the campaign's own description", () => {
    expect(system).toMatch(/freelance 3D modeller looking for contract work/);
  });

  it("states the campaign's ask", () => {
    expect(system).toMatch(/consider me for 3D modelling contract work/);
  });

  it("keeps the grounding and no-prior-relationship rules", () => {
    expect(system).toMatch(/Invent no numbers/);
    expect(system).toMatch(/prior relationship/);
  });

  it("allows an observation about the recipient, bounded to their own words", () => {
    // This replaces an earlier rule that banned saying anything about the
    // recipient at all. That prevented hallucination but also prevented the
    // specific opening line that makes cold email work; the recipient's own
    // self-description is now supplied so the observation can be true.
    expect(system).toMatch(/checkable observation about the recipient/);
    expect(system).toMatch(/drawn only from what their own site says/);
  });

  it("still refuses praise, which is the failure mode that rule guarded", () => {
    expect(system).toMatch(/observation, not a compliment/);
  });

  it("still refuses a call as the first ask", () => {
    expect(system).toMatch(/Never ask for a call in a first message/);
  });
});

describe("the ask is part of the grounding set", () => {
  // A live campaign rejected every draft it produced. Its ask named a URL,
  // the model included that URL as instructed, and the guard compared the
  // body against the facts list alone — so following the instruction was
  // scored as a fabrication. These are the real values from that campaign.
  const INTRO =
    "Anthony owner of threatcrush.com we want to generate leads for people to download our free whitepaper at https://threatcrush.com/get-whitepaper";
  const ASK =
    "we want to generate leads for people to download our free whitepaper at https://threatcrush.com/get-whitepaper";
  const FACTS = ["30 years experience at small startups and enterprise companies as a software engineer."];
  const declared = [...FACTS, INTRO, ASK];

  it("accepts a URL the ask told it to include", () => {
    const body =
      "You can grab the free whitepaper at https://threatcrush.com/get-whitepaper whenever it is useful.";
    expect(unsupportedCustomClaims(body, declared)).toEqual([]);
  });

  it("rejected it when only the facts were checked, which was the bug", () => {
    const body = "Grab it at https://threatcrush.com/get-whitepaper";
    expect(unsupportedCustomClaims(body, FACTS).join(" ")).toMatch(/threatcrush/);
  });

  it("still catches a URL nobody wrote anywhere", () => {
    const body = "See https://not-ours.test/landing for details.";
    expect(unsupportedCustomClaims(body, declared).join(" ")).toMatch(/not-ours\.test/);
  });

  it("accepts a number stated in the facts", () => {
    expect(unsupportedCustomClaims("I have 30 years of experience.", declared)).toEqual([]);
  });

  it("still catches an invented number", () => {
    expect(unsupportedCustomClaims("We have 450 customers.", declared).join(" ")).toMatch(/450/);
  });
});
