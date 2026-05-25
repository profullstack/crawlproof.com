import { describe, it, expect } from "vitest";
import {
  AUDIT_PROMPT_TEMPLATE,
  DATA_POINTS,
  SECTIONS,
  SOURCES,
} from "@/lib/audit/prompt";

// These constants are the public contract for the audit deliverable.
// Tests pin them down so a refactor doesn't accidentally drop a section,
// rename a data point, or break the report format used by the worker, the
// dashboard, and the Markdown report.
describe("audit prompt constants", () => {
  it("exposes the canonical sections in the prompt order", () => {
    expect(SECTIONS).toHaveLength(14);
    expect(SECTIONS[0]).toBe("Crawl Summary");
    expect(SECTIONS[1]).toBe("Data Found");
    expect(SECTIONS[2]).toBe("Homepage Audit");
    expect(SECTIONS).toContain("Content Quality");
    expect(SECTIONS).toContain("Links & Images");
    expect(SECTIONS).toContain("Performance");
    expect(SECTIONS).toContain("Security");
    expect(SECTIONS).toContain("LLM / AI Crawler Accessibility");
    expect(SECTIONS[SECTIONS.length - 1]).toBe("Priority To-Do List");
  });

  it("data point list matches the prompt deliverable", () => {
    expect(DATA_POINTS).toContain("Pricing");
    expect(DATA_POINTS).toContain("Customer logos");
    expect(DATA_POINTS).toContain("Contact/demo/signup paths");
    expect(DATA_POINTS).toContain("Executive team");
    expect(DATA_POINTS).toContain("Blog post activity");
    expect(DATA_POINTS).toHaveLength(12);
  });

  it("sources list covers the standard places we look", () => {
    expect(SOURCES).toContain("Homepage");
    expect(SOURCES).toContain("robots.txt");
    expect(SOURCES).toContain("sitemap.xml");
    expect(SOURCES).toContain("Schema/structured data");
    expect(SOURCES).toContain("About/team page");
    expect(SOURCES).toContain("Pricing page");
  });

  it("AUDIT_PROMPT_TEMPLATE includes the target URL and the 10 numbered headers", () => {
    const out = AUDIT_PROMPT_TEMPLATE("https://example.com");
    expect(out).toContain("https://example.com");
    for (let i = 1; i <= 10; i++) {
      expect(out).toContain(`## ${i}.`);
    }
    expect(out).toContain("| Data Point | Found? | Source | Notes |");
  });
});
