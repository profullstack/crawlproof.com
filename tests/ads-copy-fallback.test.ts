import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_COPY_PROVIDER } from "@/lib/ads/agent";

const generate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lx/backendAi", async (original) => ({
  ...(await original<typeof import("@/lib/lx/backendAi")>()),
  generateStructuredOutput: generate,
}));
vi.mock("@/lib/ads/heroImage", () => ({ resolveAdHeroImage: vi.fn(async () => null) }));
vi.mock("@/lib/ads/brand", async (original) => ({
  ...(await original<typeof import("@/lib/ads/brand")>()),
  extractSiteBrand: vi.fn(async () => ({
    url: "https://hqterm.sh/",
    domain: "hqterm.sh",
    title: "hqterm — terminals that survive sleep",
    description: "Persistent terminals over plain SSH.",
    text: "hqterm keeps your shell alive across sleep and network changes.",
    logoUrl: null,
    ogImage: null,
    themeColor: null,
    palette: [],
  })),
}));

const { draftAdCreatives, generateAdCreatives, readC0mputeCopy, creativesFromCopy, DESIGN_FORMAT_IDS } = await import(
  "@/lib/ads/creative"
);

const dead = new Error("Backend AI generation failed (c0mpute: no node; openai: 429; anthropic: 400)");

beforeEach(() => {
  generate.mockReset();
});

describe("readC0mputeCopy", () => {
  it("keeps an answer whose only fault is length", () => {
    const copy = readC0mputeCopy({
      headline: "Stop Losing Traffic To Broken Links On Every Page You Publish",
      body: "CrawlProof monitors your entire site all day long. We find broken links, track visitor behavior, and even run a network of ads between your indie sites.",
      ctaText: "Start Monitoring Your Site",
    });
    expect(copy.headline.length).toBeLessThanOrEqual(48);
    expect(copy.headline.endsWith(" ")).toBe(false);
    expect(copy.body).toBe("CrawlProof monitors your entire site all day long.");
    expect(copy.ctaText.length).toBeLessThanOrEqual(18);
  });

  it("marks a cut with no sentence end to stop at", () => {
    const copy = readC0mputeCopy({ headline: "H", body: "word ".repeat(60) });
    expect(copy.body.length).toBeLessThanOrEqual(130);
    expect(copy.body.endsWith("word…")).toBe(true);
  });

  it("fills what an ad can do without", () => {
    const copy = readC0mputeCopy({ headline: "Sources in, feeds out, every single day of it", body: "b" });
    expect(copy.shortHeadline.length).toBeLessThanOrEqual(28);
    expect(copy.ctaText).toBe("Learn more");
    expect(copy.summaryLong).toBe("");
  });

  it("rejects an answer with no ad in it, so the next provider gets a turn", () => {
    expect(() => readC0mputeCopy({ headline: "only" })).toThrow(/required/);
    expect(() => readC0mputeCopy({ headline: { type: "string" }, body: { type: "string" } })).toThrow(/required/);
    expect(() => readC0mputeCopy(null)).toThrow(/required/);
  });
});

describe("generateAdCreatives when every provider fails", () => {
  it("writes a first draft from the page", async () => {
    generate.mockRejectedValue(dead);
    const out = await generateAdCreatives("https://hqterm.sh", { pageCopyOnFailure: true });
    expect(out.provider).toBe(PAGE_COPY_PROVIDER);
    expect(out.creatives.map((c) => c.format)).toEqual([...DESIGN_FORMAT_IDS]);
    expect(out.creatives[0].headline).toBe("hqterm");
    expect(out.creatives[0].body).toBe("Persistent terminals over plain SSH.");
  });

  it("still throws by default, because regenerate and A/B arms must not get page copy", async () => {
    generate.mockRejectedValue(dead);
    await expect(generateAdCreatives("https://hqterm.sh")).rejects.toThrow("Backend AI generation failed");
  });

  it("uses a model when one answers, and offers c0mpute the lenient reader", async () => {
    generate.mockResolvedValue({
      provider: "c0mpute",
      output: readC0mputeCopy({ headline: "Terminals that survive sleep", body: "Close the laptop." }),
    });
    const out = await generateAdCreatives("https://hqterm.sh", { pageCopyOnFailure: true });
    expect(out.provider).toBe("ad-generator-agent/c0mpute");
    expect(out.creatives[0].headline).toBe("Terminals that survive sleep");
    expect(generate.mock.calls[0][0].c0mputeParse).toBe(readC0mputeCopy);
  });
});

describe("draftAdCreatives", () => {
  it("makes every design format from the page without calling a model", async () => {
    const out = await draftAdCreatives("https://hqterm.sh");
    expect(generate).not.toHaveBeenCalled();
    expect(out.creatives.map((c) => c.format)).toEqual([...DESIGN_FORMAT_IDS]);
    expect(out.brand.domain).toBe("hqterm.sh");
  });
});

describe("creativesFromCopy", () => {
  it("leaves out formats it has no words for", () => {
    const brand = { url: "https://x.test/", domain: "x.test", title: "", description: "", text: "", logoUrl: null, ogImage: null, themeColor: null, palette: [] };
    const copy = readC0mputeCopy({ headline: "H", body: "B" });
    expect(creativesFromCopy(brand as never, { ...copy, body: "  " }, null)).toEqual([]);
  });
});
