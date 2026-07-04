import { describe, it, expect } from "vitest";
import { getCategory, launchDefaults, ALERT_CATEGORIES } from "@/lib/alerts/categories";
import { htmlHasLinkTo } from "@/lib/alerts/backlink";

describe("category compilation", () => {
  it("compiles a brand alert to a quoted phrase", () => {
    const c = getCategory("brand")!.compile("Acme Widgets");
    expect(c.query).toBe('"Acme Widgets"');
    expect(c.confirmBacklink).toBe(false);
    expect(c.label).toContain("Acme Widgets");
  });

  it("compiles a backlink alert with a domain filter and crawl-confirm flag", () => {
    const c = getCategory("backlink")!.compile("https://www.acme.com/pricing");
    expect(c.query).toBe('"acme.com" -site:acme.com');
    expect(c.confirmBacklink).toBe(true);
    expect(c.backlinkDomain).toBe("acme.com");
  });

  it("compiles buying-intent into best/alternative phrasing", () => {
    const c = getCategory("buying_intent")!.compile("CRM");
    expect(c.query).toContain('"best CRM for"');
    expect(c.query).toContain('"alternative to CRM"');
  });

  it("passes a custom query through verbatim", () => {
    const raw = '"acme" (review OR launch) -site:acme.com';
    expect(getCategory("custom")!.compile(raw).query).toBe(raw);
  });

  it("exposes exactly five launch-set defaults", () => {
    expect(launchDefaults().map((c) => c.key).sort()).toEqual(
      ["backlink", "brand", "buying_intent", "competitor", "name"].sort(),
    );
  });

  it("marks people-tracking categories as gated (withheld from launch picker)", () => {
    for (const key of ["name", "reputation", "impersonation", "legal"]) {
      expect(getCategory(key)!.gated).toBe(true);
    }
  });

  it("every category compiles to a non-empty query", () => {
    for (const c of ALERT_CATEGORIES) {
      expect(c.compile("test term").query.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("backlink anchor detection", () => {
  const domain = "acme.com";
  it("confirms a real anchor to the domain", () => {
    expect(htmlHasLinkTo('<a href="https://acme.com/x">Acme</a>', domain)).toBe(true);
    expect(htmlHasLinkTo('<a href="https://blog.acme.com/x">Acme</a>', domain)).toBe(true);
  });
  it("does not treat a plain-text mention as a link", () => {
    expect(htmlHasLinkTo("<p>We love acme.com but never linked it.</p>", domain)).toBe(false);
  });
  it("ignores links to other domains", () => {
    expect(htmlHasLinkTo('<a href="https://other.com/acme.com">x</a>', domain)).toBe(false);
  });
});
