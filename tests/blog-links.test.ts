import { describe, expect, it } from "vitest";
import { closestSlug, editDistance, fixBlogLinks, resolveMissingSlug } from "@/lib/blog/links";

const SLUGS = new Set(["schema-markup-checklist-for-marketers", "threat-intelligence-aeo", "convex-optimization-for-aeo"]);

describe("blog link repair", () => {
  it("finds the slug a mistyped link meant", () => {
    expect(editDistance("threat-inteligence-aeo", "threat-intelligence-aeo")).toBe(1);
    expect(closestSlug("threat-inteligence-aeo", SLUGS)).toBe("threat-intelligence-aeo");
    expect(closestSlug("quantum-firewall-guide", SLUGS)).toBeNull();
  });

  it("sends the retired seed slugs found by Link Watch to their replacement", () => {
    expect(resolveMissingSlug("what-is-aeo", SLUGS)).toBe("/docs/aeo-score");
    expect(resolveMissingSlug("llms-txt-and-skill-md", SLUGS)).toBe("/docs/aeo-score");
    expect(resolveMissingSlug("threat-inteligence-aeo", SLUGS)).toBe("/blog/threat-intelligence-aeo");
    expect(resolveMissingSlug("quantum-firewall-guide", SLUGS)).toBeNull();
  });

  it("rewrites the live bad links, absolute and relative, keeping anchors on posts", () => {
    const html =
      '<a href="https://crawlproof.com/blog/what-is-aeo">a</a> <a href="/blog/llms-txt-and-skill-md">b</a> <a href="/blog/threat-inteligence-aeo#x">c</a>';
    expect(fixBlogLinks(html, SLUGS)).toBe(
      '<a href="https://crawlproof.com/docs/aeo-score">a</a> <a href="/docs/aeo-score">b</a> <a href="/blog/threat-intelligence-aeo#x">c</a>',
    );
  });

  it("points a never-published slug at the index; leaves good and external links alone", () => {
    const html =
      '<a href="/blog/quantum-firewall-guide">q</a><a href="/blog/threat-intelligence-aeo">ok</a><a href="https://other.example/blog/nope">e</a>';
    expect(fixBlogLinks(html, SLUGS)).toBe(
      '<a href="/blog">q</a><a href="/blog/threat-intelligence-aeo">ok</a><a href="https://other.example/blog/nope">e</a>',
    );
    expect(fixBlogLinks(html, new Set())).toBe(html);
  });
});
