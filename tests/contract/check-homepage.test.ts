import { describe, it, expect } from "vitest";
import { checkHomepage } from "@/lib/audit/checks/homepage";
import type { CrawlContext, FetchedPage } from "@/lib/audit/types";

function ctx(html: string, opts: Partial<FetchedPage> = {}): CrawlContext {
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
    fetchMs: 100,
    ...opts,
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

function findKey(arr: ReturnType<typeof checkHomepage>, key: string) {
  return arr.find((f) => f.check_key === key);
}

describe("checkHomepage", () => {
  it("flags a missing H1 as fail", () => {
    const out = checkHomepage(
      ctx("<html><body><p>no header</p></body></html>"),
    );
    expect(findKey(out, "homepage.h1")?.status).toBe("fail");
  });

  it("accepts a single H1 as pass", () => {
    const out = checkHomepage(
      ctx("<html><body><h1>We help X do Y</h1></body></html>"),
    );
    expect(findKey(out, "homepage.h1")?.status).toBe("pass");
  });

  it("warns on multiple H1s", () => {
    const out = checkHomepage(
      ctx("<html><body><h1>One</h1><h1>Two</h1></body></html>"),
    );
    expect(findKey(out, "homepage.h1")?.status).toBe("warn");
  });

  it("flags missing <title>", () => {
    const out = checkHomepage(ctx("<html><body><h1>x</h1></body></html>"));
    expect(findKey(out, "homepage.title")?.status).toBe("fail");
  });

  it("warns on a very short <title>", () => {
    const out = checkHomepage(
      ctx("<html><head><title>Hi</title></head><body><h1>x</h1></body></html>"),
    );
    expect(findKey(out, "homepage.title")?.status).toBe("warn");
  });

  it("passes when title is a reasonable length", () => {
    const out = checkHomepage(
      ctx(
        "<html><head><title>CrawlProof — AEO audits for AI crawlers</title></head><body><h1>x</h1></body></html>",
      ),
    );
    expect(findKey(out, "homepage.title")?.status).toBe("pass");
  });

  it("warns on missing meta description, passes when present", () => {
    const without = checkHomepage(
      ctx(
        "<html><head><title>Title good enough</title></head><body><h1>x</h1></body></html>",
      ),
    );
    expect(findKey(without, "homepage.description")?.status).toBe("warn");
    const withDesc = checkHomepage(
      ctx(
        `<html><head><title>Title good</title><meta name="description" content="we help X"></head><body><h1>x</h1></body></html>`,
      ),
    );
    expect(findKey(withDesc, "homepage.description")?.status).toBe("pass");
  });

  it("emits a fail when the homepage couldn't be fetched", () => {
    const out = checkHomepage(ctx("", { status: 503, rawHtml: "" }));
    expect(findKey(out, "homepage.fetch")?.status).toBe("fail");
  });

  it("detects JS-rendered-only content via rendered vs raw text ratio", () => {
    const raw = "<html><body><div id=root></div></body></html>";
    const c = ctx(raw, {
      renderedText: "A".repeat(5000) + " landed after hydration",
      renderedBytes: 5000,
    });
    const out = checkHomepage(c);
    expect(findKey(out, "homepage.js_rendered")?.status).toBe("fail");
  });

  it("passes the JS-rendered check when raw and rendered text are similar", () => {
    const raw = `<html><body>${"some real server text. ".repeat(50)}</body></html>`;
    const c = ctx(raw, {
      renderedText: "some real server text. ".repeat(50),
      renderedBytes: raw.length,
    });
    const out = checkHomepage(c);
    expect(findKey(out, "homepage.js_rendered")?.status).toBe("pass");
  });
});
