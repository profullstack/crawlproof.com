import { describe, it, expect } from "vitest";
import { checkSchema } from "@/lib/audit/checks/schema";
import type { CrawlContext, FetchedPage } from "@/lib/audit/types";

function ctx(html: string): CrawlContext {
  const target = "https://example.com/";
  const page: FetchedPage = {
    url: target,
    finalUrl: target,
    status: 200,
    fetchedAt: new Date().toISOString(),
    contentType: "text/html",
    headers: {},
    rawHtml: html,
    bytes: html.length,
    fetchMs: 50,
  };
  return {
    target,
    origin: "https://example.com",
    host: "example.com",
    pages: { [target]: page },
    wellKnown: {},
    findings: [],
  };
}

const find = (arr: ReturnType<typeof checkSchema>, key: string) =>
  arr.find((f) => f.check_key === key);

describe("checkSchema", () => {
  it("flags fail when there is no JSON-LD", () => {
    const out = checkSchema(ctx("<html><body><h1>x</h1></body></html>"));
    expect(find(out, "schema.any")?.status).toBe("fail");
  });

  it("passes when valid JSON-LD is present and detects the types", () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Example",
      })}</script>
      </head><body></body></html>`;
    const out = checkSchema(ctx(html));
    expect(find(out, "schema.any")?.status).toBe("pass");
    expect(find(out, "schema.org")?.status).toBe("pass");
  });

  it("flags fail on invalid JSON inside ld+json", () => {
    const html = `<html><head>
      <script type="application/ld+json">{ not-valid-json }</script>
      </head><body></body></html>`;
    const out = checkSchema(ctx(html));
    expect(find(out, "schema.invalid")?.status).toBe("fail");
  });

  it("warns when FAQPage / WebSite / Product schema are absent", () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Organization",
        name: "Example",
      })}</script>
      </head><body></body></html>`;
    const out = checkSchema(ctx(html));
    expect(find(out, "schema.faq")?.status).toBe("warn");
    expect(find(out, "schema.web")?.status).toBe("warn");
    expect(find(out, "schema.product")?.status).toBe("warn");
  });

  it("supports @graph arrays of JSON-LD nodes", () => {
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Example" },
          { "@type": "WebSite", url: "https://example.com" },
        ],
      })}</script>
      </head><body></body></html>`;
    const out = checkSchema(ctx(html));
    expect(find(out, "schema.web")?.status).toBe("pass");
    expect(find(out, "schema.org")?.status).toBe("pass");
  });
});
