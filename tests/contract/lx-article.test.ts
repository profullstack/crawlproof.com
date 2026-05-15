import { describe, it, expect } from "vitest";
import { slugify, validateInternalLinks } from "@/lib/lx/articleGen";

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
