import { describe, it, expect } from "vitest";
import { collectDataPoints } from "@/lib/audit/checks/dataPoints";
import { DATA_POINTS } from "@/lib/audit/prompt";
import type { CrawlContext, FetchedPage } from "@/lib/audit/types";

function makeCtx(homepage: string, extraPages: Record<string, string> = {}): CrawlContext {
  const target = "https://example.com/";
  const pages: Record<string, FetchedPage> = {};
  pages[target] = page(target, homepage);
  for (const [url, html] of Object.entries(extraPages)) {
    pages[url] = page(url, html);
  }
  return {
    target,
    origin: "https://example.com",
    host: "example.com",
    pages,
    wellKnown: {},
    findings: [],
  };
}

function page(url: string, html: string): FetchedPage {
  return {
    url,
    finalUrl: url,
    status: 200,
    fetchedAt: new Date().toISOString(),
    contentType: "text/html",
    headers: {},
    rawHtml: html,
    bytes: html.length,
    fetchMs: 1,
  };
}

describe("collectDataPoints", () => {
  it("covers every canonical data point in the output", () => {
    const rows = collectDataPoints(makeCtx("<html><body><h1>Hi</h1></body></html>"));
    const points = new Set(rows.map((r) => r.dataPoint));
    for (const expected of DATA_POINTS) expect(points.has(expected)).toBe(true);
  });

  it("finds Pricing via a Pricing page URL", () => {
    const rows = collectDataPoints(
      makeCtx(
        `<html><body><nav><a href="/pricing">Pricing</a></nav></body></html>`,
        { "https://example.com/pricing": "<html><body>plans</body></html>" },
      ),
    );
    const pricing = rows.find((r) => r.dataPoint === "Pricing")!;
    expect(pricing.found).toBe(true);
    expect(pricing.source).toBe("Pricing page");
  });

  it("finds Executive team when an /about page is linked", () => {
    const rows = collectDataPoints(
      makeCtx(
        `<html><body><nav><a href="/about">About</a></nav></body></html>`,
        { "https://example.com/about": "<html><body>team</body></html>" },
      ),
    );
    expect(rows.find((r) => r.dataPoint === "Executive team")?.found).toBe(true);
  });

  it("finds Headline copy from the H1", () => {
    const rows = collectDataPoints(
      makeCtx("<html><body><h1>We help X do Y</h1></body></html>"),
    );
    const head = rows.find((r) => r.dataPoint === "Headline copy")!;
    expect(head.found).toBe(true);
    expect(head.notes).toMatch(/We help X/);
  });

  it("flags Customer logos when the homepage uses 'trusted by' / 'used by'", () => {
    const rows = collectDataPoints(
      makeCtx("<html><body>Trusted by Fortune 500 teams</body></html>"),
    );
    expect(rows.find((r) => r.dataPoint === "Customer logos")?.found).toBe(true);
    expect(rows.find((r) => r.dataPoint === "Social proof")?.found).toBe(true);
  });

  it("marks Pricing as not found when neither a link nor a page exists", () => {
    const rows = collectDataPoints(
      makeCtx("<html><body><h1>Nothing</h1></body></html>"),
    );
    const pricing = rows.find((r) => r.dataPoint === "Pricing")!;
    expect(pricing.found).toBe(false);
    expect(pricing.source).toBeNull();
  });
});
