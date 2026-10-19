import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { itemsToFindings, parsePlan, specScore } from "../lib/audit/spec-engine";
import { linksAudit } from "../lib/audit/links-engine";
import type { FetchedPage } from "../lib/audit/types";

const PLAN = `
- **The HTML doctype** (required) — Every HTML document must start with <!doctype html>.
  Reference: https://specification.website/spec/foundations/doctype/
- **HSTS (Strict-Transport-Security)** (required) — HSTS tells browsers to only ever use HTTPS.
  Reference: https://specification.website/spec/security/hsts/
- **Skip links** (required) — A skip link as the first focusable element.
  Reference: https://specification.website/spec/accessibility/skip-links/
- **Colour contrast** (required) — Text must have enough contrast.
  Reference: https://specification.website/spec/accessibility/color-contrast/
`;

const page = (html: string, headers: Record<string, string> = {}): FetchedPage => ({
  url: "https://example.test/",
  finalUrl: "https://example.test/",
  status: 200,
  fetchedAt: new Date().toISOString(),
  contentType: "text/html",
  headers,
  rawHtml: html,
  bytes: html.length,
  fetchMs: 1,
});

describe("spec engine verifies what it can", () => {
  it("parses the checklist and checks items against the page; unverifiable ones stay out of the score", () => {
    const items = parsePlan(PLAN);
    expect(items.map((i) => i.title)).toEqual(["The HTML doctype", "HSTS (Strict-Transport-Security)", "Skip links", "Colour contrast"]);
    const good = itemsToFindings(items, page('<!doctype html><html lang="en"><body><a href="#main">Skip to content</a><main id="main"></main></body></html>', { "strict-transport-security": "max-age=31536000" }), {});
    expect(good.map((f) => f.status)).toEqual(["pass", "pass", "pass", "unknown"]);
    expect(specScore(good)).toBe(100);
    const bad = itemsToFindings(items, page("<html><body><a href='/x'>x</a></body></html>"), {});
    expect(bad.map((f) => f.status)).toEqual(["fail", "fail", "fail", "unknown"]);
    expect(specScore(bad)).toBe(0);
  });

  it("with nothing verifiable (page unreachable) the score stays neutral", () => {
    expect(specScore(itemsToFindings(parsePlan(PLAN), null, {}))).toBe(50);
  });
});

describe("link checker scores the site's own links", () => {
  it("an outbound link another site refuses does not fail the audit", async () => {
    const other = createServer((_, res) => res.writeHead(403).end("no bots")).listen(0, "127.0.0.1");
    await new Promise((r) => other.once("listening", r));
    const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    // Same IP, different port: still "another site" by host.
    const site = createServer((_, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><a href="${otherUrl}/a">a</a><a href="${otherUrl}/b">b</a><a href="${otherUrl}/c">c</a></body></html>`);
    }).listen(0, "localhost");
    await new Promise((r) => site.once("listening", r));
    try {
      const result = await linksAudit(`http://localhost:${(site.address() as AddressInfo).port}/`);
      const own = result.findings.find((f) => f.check_key === "links.crawl_broken");
      const ext = result.findings.find((f) => f.check_key === "links.external_broken");
      expect(own?.status).toBe("pass");
      expect(ext?.status).toBe("warn");
      expect(result.score).toBeGreaterThan(90);
    } finally {
      other.close();
      site.close();
    }
  }, 30_000);
});
