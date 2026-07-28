import { describe, it, expect } from "vitest";
import { pdfLinksFrom, teamPageLinks } from "@/lib/outreach/documents";

describe("pdfLinksFrom", () => {
  const html = `
    <a href="/legal/terms-and-conditions.pdf">Terms</a>
    <a href="/files/capability-statement.pdf">Capability statement</a>
    <a href="https://cdn.other.test/media-kit.pdf">Media kit</a>
    <a href="/about">About</a>`;

  it("puts documents likely to name people first", () => {
    // A twelve-megabyte download is worth spending on a capability
    // statement and not on a terms-and-conditions, and the filename is the
    // only signal available before paying for it.
    const links = pdfLinksFrom(html, "https://acme.test/", 3);
    expect(links[0]).toMatch(/capability-statement|media-kit/);
    expect(links[links.length - 1]).toMatch(/terms-and-conditions/);
  });

  it("resolves relative hrefs and keeps off-host documents", () => {
    // A media kit on a CDN is still the company's own document.
    const links = pdfLinksFrom(html, "https://acme.test/");
    expect(links).toContain("https://cdn.other.test/media-kit.pdf");
  });

  it("ignores links that are not documents", () => {
    expect(pdfLinksFrom(html, "https://acme.test/").some((l) => l.endsWith("/about"))).toBe(false);
  });

  it("honours the limit, since each link is a real download", () => {
    expect(pdfLinksFrom(html, "https://acme.test/", 1)).toHaveLength(1);
  });

  it("handles a query string after the extension", () => {
    const links = pdfLinksFrom(`<a href="/f/brochure.pdf?v=2">x</a>`, "https://acme.test/");
    expect(links[0]).toContain("brochure.pdf?v=2");
  });

  it("returns nothing when there are no documents", () => {
    expect(pdfLinksFrom(`<a href="/about">About</a>`, "https://acme.test/")).toEqual([]);
  });
});

describe("teamPageLinks", () => {
  const html = `
    <a href="/our-team">Our team</a>
    <a href="/leadership/">Leadership</a>
    <a href="/blog/meet-the-team-behind-x">Blog post</a>
    <a href="https://other.test/team">Someone else's team</a>
    <a href="/about">About</a>`;

  it("finds the pages that name people", () => {
    const links = teamPageLinks(html, "https://acme.test/", 5);
    expect(links).toContain("https://acme.test/our-team");
    expect(links).toContain("https://acme.test/leadership");
  });

  it("stays on the prospect's own host", () => {
    // Another company's team page names the wrong people entirely.
    expect(teamPageLinks(html, "https://acme.test/", 5)).not.toContain("https://other.test/team");
  });

  it("does not mistake a blog post for a team page", () => {
    const links = teamPageLinks(html, "https://acme.test/", 5);
    expect(links.some((l) => l.includes("/blog/"))).toBe(false);
  });

  it("normalises a trailing slash so one page is not fetched twice", () => {
    const links = teamPageLinks(`<a href="/team/">T</a><a href="/team">T</a>`, "https://acme.test/");
    expect(links).toEqual(["https://acme.test/team"]);
  });

  it("returns nothing for an unparseable source", () => {
    expect(teamPageLinks(html, "not a url")).toEqual([]);
  });
});
