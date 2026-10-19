import { describe, it, expect } from "vitest";
import { splitHtmlForMidAd, stripTrailingAd } from "@/lib/blog/split-html";

const para = (n: number) => `<p>Paragraph ${n} ${"filler ".repeat(20)}</p>`;
const longArticle = Array.from({ length: 12 }, (_, i) => para(i)).join("\n");

describe("splitHtmlForMidAd", () => {
  it("splits a long article and loses nothing", () => {
    const split = splitHtmlForMidAd(longArticle);
    expect(split).not.toBeNull();
    expect(split!.before + split!.after).toBe(longArticle);
    expect(split!.before.trim()).not.toBe("");
    expect(split!.after.trim()).not.toBe("");
  });

  it("cuts on a block boundary, leaving balanced <p> tags", () => {
    const split = splitHtmlForMidAd(longArticle)!;
    const opens = (s: string) => (s.match(/<p>/g) ?? []).length;
    const closes = (s: string) => (s.match(/<\/p>/g) ?? []).length;
    expect(opens(split.before)).toBe(closes(split.before));
    expect(opens(split.after)).toBe(closes(split.after));
  });

  it("cuts near the middle, not at the edges", () => {
    const split = splitHtmlForMidAd(longArticle)!;
    const fraction = split.before.length / longArticle.length;
    expect(fraction).toBeGreaterThanOrEqual(0.25);
    expect(fraction).toBeLessThanOrEqual(0.75);
  });

  // Each of these wraps a big container around the article's midpoint, so the
  // naive "cut nearest the middle" would land inside it. Leading and trailing
  // paragraphs guarantee a legal boundary exists, keeping the assertions live
  // rather than vacuously skipped.
  const balanced = (s: string, tag: string) =>
    (s.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length ===
    (s.match(new RegExp(`</${tag}>`, "g")) ?? []).length;

  const wrap = (middle: string) => {
    const edge = Array.from({ length: 6 }, (_, i) => para(i)).join("");
    return `${edge}${middle}${edge}`;
  };

  it("never cuts inside a list", () => {
    const items = Array.from(
      { length: 30 },
      (_, i) => `<li>Item ${i} ${"text ".repeat(10)}</li>`,
    ).join("");
    const split = splitHtmlForMidAd(wrap(`<ul>${items}</ul>`));
    expect(split).not.toBeNull();
    expect(balanced(split!.before, "ul")).toBe(true);
    expect(balanced(split!.before, "li")).toBe(true);
    expect(split!.after.trimStart().startsWith("</")).toBe(false);
  });

  it("never cuts inside a blockquote", () => {
    const quote = `<blockquote>${Array.from({ length: 20 }, (_, i) => para(i)).join("")}</blockquote>`;
    const split = splitHtmlForMidAd(wrap(quote));
    expect(split).not.toBeNull();
    expect(balanced(split!.before, "blockquote")).toBe(true);
  });

  it("never cuts inside a code block", () => {
    const code = `<pre><code>${"const x = 1;\n".repeat(200)}</code></pre>`;
    const split = splitHtmlForMidAd(wrap(code));
    expect(split).not.toBeNull();
    expect(balanced(split!.before, "pre")).toBe(true);
    expect(balanced(split!.before, "code")).toBe(true);
  });

  it("returns null for short, empty, or missing bodies", () => {
    expect(splitHtmlForMidAd("<p>short</p>")).toBeNull();
    expect(splitHtmlForMidAd("")).toBeNull();
    expect(splitHtmlForMidAd(null)).toBeNull();
    expect(splitHtmlForMidAd(undefined)).toBeNull();
  });

  it("returns null when a long body has no top-level boundary", () => {
    const oneBigList = `<ul>${Array.from(
      { length: 60 },
      (_, i) => `<li>Item ${i} ${"text ".repeat(10)}</li>`,
    ).join("")}</ul>`;
    expect(splitHtmlForMidAd(oneBigList)).toBeNull();
  });
});

describe("stripTrailingAd", () => {
  const unit =
    '<div data-cp-ad data-slot="94cd644a-bcc2-4bba-ab66-b4a89f3727cc" data-format="banner_728x90"></div>\n<script async src="https://crawlproof.com/ad.js"></script>';

  it("drops an ad unit appended after the article, so none sits above the footer", () => {
    const html = `<p>Body.</p>\n<aside class="cp-network-links"><ul><li>x</li></ul></aside>\n${unit}`;
    expect(stripTrailingAd(html)).toBe('<p>Body.</p>\n<aside class="cp-network-links"><ul><li>x</li></ul></aside>');
  });

  it("keeps an ad unit placed inside the article", () => {
    const html = `<p>Intro.</p>\n${unit}\n<h2>More</h2><p>Body.</p>`;
    expect(stripTrailingAd(html)).toBe(html);
  });
});
