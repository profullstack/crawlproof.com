import { describe, it, expect } from "vitest";
import {
  extractSectionForMarker,
  slugify,
  validateInternalLinks,
} from "@/lib/lx/articleGen";

describe("slugify", () => {
  it("lowercases + dasherizes", () => {
    expect(slugify("How To Do A Thing")).toBe("how-to-do-a-thing");
  });
  it("collapses runs of non-alphanum to a single dash", () => {
    expect(slugify("foo!!! bar ??? baz")).toBe("foo-bar-baz");
  });
  it("strips leading/trailing dashes", () => {
    expect(slugify("--what now?--")).toBe("what-now");
  });
  it("truncates to max length without leaving a trailing dash", () => {
    const long = "lorem ipsum dolor sit amet consectetur adipiscing";
    const slug = slugify(long, 25);
    expect(slug.length).toBeLessThanOrEqual(25);
    expect(slug.endsWith("-")).toBe(false);
  });
  it("removes diacritics", () => {
    expect(slugify("Café résumé")).toBe("cafe-resume");
  });
  it("returns empty string for whitespace-only", () => {
    expect(slugify("   ")).toBe("");
  });
});

describe("validateInternalLinks", () => {
  const md = `
Some intro text.

Read more about [our product](https://example.com/product) and the
[pricing model](https://example.com/pricing).
`;

  it("returns ok when all expected URLs appear in the body", () => {
    const r = validateInternalLinks(md, [
      "https://example.com/product",
      "https://example.com/pricing",
    ]);
    expect(r.ok).toBe(true);
  });

  it("reports the missing URLs when the model dropped one", () => {
    const r = validateInternalLinks(md, [
      "https://example.com/product",
      "https://example.com/customers", // not in body
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["https://example.com/customers"]);
  });

  it("returns ok with an empty expected list (no link slots)", () => {
    expect(validateInternalLinks(md, []).ok).toBe(true);
  });
});

describe("extractSectionForMarker", () => {
  const body = `
## Intro

Some opening prose.

## How latency breaks pipelines

Pipelines fall apart when p99 exceeds 800ms. Teams routinely see
this in production. Concrete numbers from our own audits: 42% of
runs spent more than 5s waiting on a single hop.

<!--INLINE_IMAGE_1-->

The fix is to fan out at the edge.

## What to do about it

Three steps:

1. Measure per-hop latency.
2. Identify the worst offender.
3. Shard or cache it.

<!--INLINE_IMAGE_2-->

This usually drops p99 by ~60% in two weeks.

## ![hero](https://example.com/x.png) Closing

Wrap-up section.

<!--INLINE_IMAGE_3-->

That's it.
`;

  it("pulls the H2 + body around marker 1", () => {
    const out = extractSectionForMarker(body, 1);
    expect(out).toContain("How latency breaks pipelines");
    expect(out).toContain("42%");
    expect(out).toContain("800ms");
    expect(out).not.toContain("Three steps");
    expect(out).not.toContain("<!--INLINE_IMAGE_1-->");
  });

  it("pulls the next H2's section for marker 2 (boundaries are correct)", () => {
    const out = extractSectionForMarker(body, 2);
    expect(out).toContain("What to do about it");
    expect(out).toContain("Three steps");
    expect(out).not.toContain("42%");
    expect(out).not.toContain("Closing");
  });

  it("strips markdown image syntax from the heading line", () => {
    const out = extractSectionForMarker(body, 3);
    expect(out).toContain("Closing");
    // The ![hero](...) image syntax should not leak into the excerpt.
    expect(out).not.toContain("example.com/x.png");
    expect(out).not.toContain("![");
  });

  it("returns empty string when the marker is missing", () => {
    expect(extractSectionForMarker(body, 99)).toBe("");
  });

  it("returns empty string when the marker has no preceding H2", () => {
    const noH2 = "Just prose.\n\n<!--INLINE_IMAGE_1-->\n\nMore prose.";
    expect(extractSectionForMarker(noH2, 1)).toBe("");
  });

  it("respects the length cap and starts with the heading sentinel", () => {
    const huge =
      "## Topic title\n\n" +
      "Long paragraph. ".repeat(500) +
      "<!--INLINE_IMAGE_1-->\n";
    const out = extractSectionForMarker(huge, 1);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out.startsWith('Section heading: "Topic title"')).toBe(true);
  });
});
