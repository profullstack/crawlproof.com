import { describe, it, expect } from "vitest";
import { checkPositioning } from "@/lib/audit/checks/positioning";
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
const find = (arr: ReturnType<typeof checkPositioning>, key: string) =>
  arr.find((f) => f.check_key === key);

const RICH_HOME = `
<html><body>
  <nav>
    <a href="/about">About</a>
    <a href="/pricing">Pricing</a>
    <a href="/contact">Contact sales</a>
  </nav>
  <h1>We help B2B SaaS marketing teams measure AEO.</h1>
  <p>Built for growth teams. The easiest way to see your site like ChatGPT.</p>
</body></html>`;

const POOR_HOME = `<html><body><div>welcome</div></body></html>`;

describe("checkPositioning", () => {
  it("passes everything when nav has About/Pricing/Contact and H1 is value-rich", () => {
    const out = checkPositioning(ctx(RICH_HOME));
    expect(find(out, "positioning.who")?.status).toBe("pass");
    expect(find(out, "positioning.what")?.status).toBe("pass");
    expect(find(out, "positioning.pricing")?.status).toBe("pass");
    expect(find(out, "positioning.cta")?.status).toBe("pass");
    expect(find(out, "positioning.audience")?.status).toBe("pass");
  });

  it("flags everything as warn/fail on a near-empty homepage", () => {
    const out = checkPositioning(ctx(POOR_HOME));
    expect(find(out, "positioning.who")?.status).toBe("warn");
    expect(find(out, "positioning.what")?.status).toBe("warn");
    expect(find(out, "positioning.pricing")?.status).toBe("warn");
    expect(find(out, "positioning.cta")?.status).toBe("fail");
  });
});
