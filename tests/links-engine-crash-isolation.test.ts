// Regression: a slow response body used to kill the whole worker.
//
// linkinator applies its per-link `timeout` as an AbortSignal.timeout on the
// fetch, wraps the body with Readable.fromWeb(), then pipes it to the HTML
// parser with the 'error' handler on the *destination* only
// (linkinator/build/src/links.js:158). pipe() does not forward source errors, so
// when the abort fires mid-body the source Readable emits an unhandled 'error'
// event and Node hard-exits — uncatchable from linksAudit(). Because start.sh
// supervises the worker and Next.js with `wait -n`, that killed the container
// and every in-flight audit with it: scan run c6c19e9b lost 13 audits to
// "Engine timed out" that had never run.
//
// The crawl now runs in a forked child, so these tests assert the failure is
// contained and reported instead of fatal.

import { describe, expect, it, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { linksAudit } from "@/lib/audit/links-engine";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/`;
}

describe("links engine crash isolation", () => {
  it("survives a body that stalls past the per-link timeout", async () => {
    // Headers and a first chunk arrive immediately, then the body stalls — the
    // abort therefore fires mid-stream, which is the fatal case.
    const base = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write('<html><body><a href="/second">second</a>');
      // never end
    });

    const result = await linksAudit(base, { perLinkTimeoutMs: 700 });

    // Reaching this line at all is the regression check: before the fix the
    // test process died here with "Unhandled 'error' event".
    expect(result).toBeTruthy();
    expect(typeof result.score).toBe("number");
    // The stall is reported, not silently swallowed.
    const keys = result.findings.map((f) => f.check_key);
    expect(
      keys.includes("links.crawl_incomplete") || keys.includes("links.crawl_error"),
    ).toBe(true);
    expect(result.markdown).toContain("Link Checker");
    // A partial sweep must never be reported as a full one.
    const coverage = result.findings.find((f) => f.check_key === "links.crawl_coverage");
    if (coverage) {
      expect(coverage.status).toBe("warn");
      expect(coverage.detail).not.toContain("Full recursive sweep");
    }
  }, 30_000);

  it("still reports normally on a healthy site", async () => {
    const base = await serve((req, res) => {
      if (req.url === "/missing") {
        res.writeHead(404).end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<html><body><a href="/missing">broken</a></body></html>');
    });

    const result = await linksAudit(base);

    const broken = result.findings.find((f) => f.check_key === "links.crawl_broken");
    expect(broken).toBeTruthy();
    expect(broken?.status).toBe("warn"); // exactly one broken link
    expect(broken?.evidence?.broken).toBe(1);
    // Crawl completed, so neither failure finding should be present.
    expect(result.findings.map((f) => f.check_key)).not.toContain("links.crawl_incomplete");
    expect(result.findings.map((f) => f.check_key)).not.toContain("links.crawl_error");
  }, 30_000);

  it("reports a fail finding when the crawl process cannot produce a report", async () => {
    // An unroutable target: the child still exits cleanly with a report rather
    // than taking the parent with it.
    const result = await linksAudit("http://127.0.0.1:1/", { perLinkTimeoutMs: 700 });
    expect(result).toBeTruthy();
    expect(result.findings.length).toBeGreaterThan(0);
  }, 30_000);
});
