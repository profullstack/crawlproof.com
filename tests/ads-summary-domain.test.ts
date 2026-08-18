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

describe("summaries that describe the page instead of the product", () => {
  // A model told never to invent will, handed an empty or unreadable page,
  // write something true about the *document*. Accurate, useless, and the last
  // thing that should be published inside somebody's blog post as though the
  // advertiser wrote it. Caught on the very first dry run against real data:
  // a .onion campaign produced "a Tor .onion address; the fetched page contains
  // no readable text".
  const meta = [
    "A Tor .onion address; the fetched page contains no readable text and provides no information.",
    "The page could not be accessed, so no description is possible.",
    "This appears to be a placeholder page with no content found.",
    "Unable to determine what this product does from the page.",
    "There is not enough information on the page to describe the service.",
  ];

  const real = [
    "Widgets is a deployment tool for small teams that do not run a platform group.",
    "CoinPay is an open-source, non-custodial crypto payment gateway with escrow and web wallets.",
    "The rollback path is the same one used to deploy, so it is exercised on every release.",
    // Must not trip on ordinary copy that merely mentions pages or content.
    "A page builder for marketing sites, with content blocks you can reorder.",
  ];

  it("recognises prose about the fetch", async () => {
    const { __test_describesTheFetch: fn } = await import("@/lib/ads/creative");
    for (const t of meta) expect(fn(t), t).toBe(true);
  });

  it("leaves real product copy alone", async () => {
    const { __test_describesTheFetch: fn } = await import("@/lib/ads/creative");
    for (const t of real) expect(fn(t), t).toBe(false);
  });
});

describe("truncation", () => {
  // The schema caps are deliberately generous because the SDK validates
  // maxLength client-side and throws the whole generation on an overrun; the
  // real limit is applied here, where going over is a trim rather than an error.
  it("cuts on a sentence boundary when there is one", () => {
    const text = "First sentence here. Second sentence runs past the limit and keeps going.";
    const out = cleanSummary(text, 40);
    expect(out).toBe("First sentence here.");
  });

  it("falls back to a word boundary rather than cutting mid-word", () => {
    const out = cleanSummary("a deployment tool for small teams everywhere", 20);
    expect(out.endsWith("te")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(/\s$/.test(out)).toBe(false);
  });

  it("leaves text under the cap untouched", () => {
    expect(cleanSummary("short enough", 400)).toBe("short enough");
  });
});
