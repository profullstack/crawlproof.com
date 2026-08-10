import { describe, expect, it } from "vitest";
import { GET as adJs } from "@/app/ad.js/route";
import { GET as statsJs } from "@/app/stats.js/route";
import { VISITOR_SNIPPET } from "@/lib/tracker/visitorSnippet";

describe("/ad.js visitor identity", () => {
  it("mints the visitor id itself instead of only reading one stats.js wrote", async () => {
    const script = await (await adJs()).text();

    // The regression this guards: ad.js used to do a bare localStorage.getItem
    // and give up. A publisher running the ad tag without the analytics tag
    // therefore sent an empty visitor on every impression — in production that
    // was ~69% of impressions with no visitor id at all.
    expect(script).toContain("function getVisitorId()");
    expect(script).toContain("var v = getVisitorId();");
    expect(script).toContain("lsSet(k, id)");
    expect(script).toContain("&v=");
  });

  it("persists in localStorage, not a cookie or sessionStorage", async () => {
    const script = await (await adJs()).text();
    expect(script).toContain("localStorage");
    expect(script).toContain("crawlproof.visitor");
    expect(script).not.toContain("sessionStorage");
    expect(script).not.toContain("document.cookie");
  });

  it("still sends no credentials with the fill request", async () => {
    const script = await (await adJs()).text();
    expect(script).toContain("credentials: 'omit'");
  });
});

describe("shared visitor snippet", () => {
  it("is inlined verbatim by both /ad.js and /stats.js", async () => {
    const ad = await (await adJs()).text();
    const stats = await (await statsJs()).text();

    // Both tags must agree on the id or an impression can't be tied back to the
    // same person the stats dashboard counted.
    expect(ad).toContain(VISITOR_SNIPPET.trim());
    expect(stats).toContain(VISITOR_SNIPPET.trim());
  });

  it("produces syntactically valid JavaScript in both tags", async () => {
    // These are string-templated into third-party pages, so a stray brace or a
    // bad interpolation ships a script that throws on every publisher site.
    // Containment assertions can't catch that; parsing can.
    const ad = await (await adJs()).text();
    const stats = await (await statsJs()).text();
    expect(() => new Function(ad)).not.toThrow();
    expect(() => new Function(stats)).not.toThrow();
  });

  it("keeps stats.js session handling working alongside the shared helpers", async () => {
    const stats = await (await statsJs()).text();
    // getSessionId builds on lsGet/lsSet/uuid from the shared snippet; make sure
    // extracting them didn't strand the session code.
    expect(stats).toContain("function getSessionId()");
    expect(stats).toContain("crawlproof.session");
    expect(stats).toContain("var memSession = null, memSessionTs = 0;");
    // memVisitor now lives in the shared snippet — exactly one declaration.
    expect(stats.match(/var memVisitor = null/g) ?? []).toHaveLength(1);
  });
});
