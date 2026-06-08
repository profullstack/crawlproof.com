import { describe, expect, it } from "vitest";
import { GET } from "@/app/stats.js/route";

describe("/stats.js", () => {
  it("sends tracking requests without browser credentials", async () => {
    const response = await GET();
    const script = await response.text();

    expect(script).toContain("credentials: 'omit'");
    expect(script).toContain("mode: 'cors'");
    expect(script).toContain("method: 'POST'");
    expect(script).toContain("headers: { 'Content-Type': 'application/json' }");
    expect(script).toContain("websiteId: siteId");
    expect(script).toContain("visitorId: visitorId");
    expect(script).toContain("sessionId: getSessionId()");
    expect(script).not.toContain("sendBeacon");
  });

  it("pins the visitor with persistent localStorage, not per-tab sessionStorage", async () => {
    const response = await GET();
    const script = await response.text();

    // Visitor id must survive tab close / reload, so it lives in localStorage.
    // The old sessionStorage approach counted every new tab as a new visitor.
    expect(script).toContain("localStorage");
    expect(script).not.toContain("sessionStorage");
    expect(script).toContain("crawlproof.visitor");
    expect(script).toContain("crawlproof.session");
  });

  it("tracks framework router changes and custom events through a global API", async () => {
    const response = await GET();
    const script = await response.text();

    expect(script).toContain("window.crawlproof.track");
    expect(script).toContain("history.pushState");
    expect(script).toContain("history.replaceState");
    expect(script).toContain("popstate");
    expect(script).toContain("data-cp-track");
  });
});
