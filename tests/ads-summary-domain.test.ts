import { describe, expect, it } from "vitest";
import { cleanSummary, summaryDomain, summaryParagraphs } from "@/lib/ads/creative";

// The summaries are prose a model wrote about a website, stored and then
// rendered inside somebody else's blog post weeks later. Two things therefore
// have to hold: the text must be safe to render, and it must still describe the
// site the campaign actually points at. The domain is what decides the second,
// which is why it is stored alongside rather than inferred at read time.

describe("summaryDomain", () => {
  it("normalises the way ad_campaigns stores a destination domain", () => {
    expect(summaryDomain("https://www.widgets.example/pricing?a=1")).toBe("widgets.example");
    expect(summaryDomain("http://Widgets.Example")).toBe("widgets.example");
    expect(summaryDomain("https://docs.widgets.example/")).toBe("docs.widgets.example");
  });

  it("returns empty for anything it cannot read a host from", () => {
    // Empty is the safe answer: a summary with no recorded domain can never be
    // shown to still match, so serving treats it as absent.
    expect(summaryDomain("not a url")).toBe("");
    expect(summaryDomain("")).toBe("");
  });
});

describe("cleanSummary", () => {
  it("keeps paragraph breaks but collapses the runs a model emits", () => {
    const out = cleanSummary("First para.\n\n\n\nSecond para.", 400);
    expect(out).toBe("First para.\n\nSecond para.");
    expect(summaryParagraphs(out)).toHaveLength(2);
  });

  it("strips markdown the model reached for despite being told not to", () => {
    // The prose is rendered as HTML and as plain text; neither wants a stray
    // asterisk, and a heading inside a sponsored paragraph is worse still.
    expect(cleanSummary("## Heading\n\n- a bullet\n\n**bold** and *italic*", 400)).toBe(
      "Heading\n\na bullet\n\nbold and italic",
    );
  });

  it("drops the control characters that would break an XML document", () => {
    expect(cleanSummary("clean\u0000text\u0007here", 400)).toBe("cleantexthere");
  });

  it("caps the length, because this is third-party text in our document", () => {
    expect(cleanSummary("x".repeat(5000), 400)).toHaveLength(400);
  });

  it("returns empty for nothing usable, which callers treat as no summary", () => {
    expect(cleanSummary(null, 400)).toBe("");
    expect(cleanSummary("   \n\n  ", 400)).toBe("");
    expect(cleanSummary(undefined, 400)).toBe("");
  });

  it("normalises newlines so paragraph splitting is not platform-dependent", () => {
    expect(summaryParagraphs(cleanSummary("a\r\n\r\nb", 400))).toEqual(["a", "b"]);
  });
});
