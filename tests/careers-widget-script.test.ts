import { describe, it, expect } from "vitest";
import { GET as careersScript } from "@/app/careers.js/route";
import { GET as statsScript } from "@/app/stats.js/route";

// /careers.js and /stats.js are hand-written JavaScript embedded in a template
// literal, so the compiler never parses them. A typo would ship straight to
// every customer's site. These tests parse the served body.

async function body(handler: () => Promise<Response>) {
  const res = await handler();
  return { res, text: await res.text() };
}

describe("/careers.js", () => {
  it("serves parseable JavaScript as a cacheable script", async () => {
    const { res, text } = await body(careersScript);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(() => new Function(text)).not.toThrow();
  });

  it("mounts on the documented containers", async () => {
    const { text } = await body(careersScript);
    expect(text).toContain("[data-cp-careers]");
    expect(text).toContain("getElementById('careers')");
  });

  it("posts applications to the public intake endpoint", async () => {
    const { text } = await body(careersScript);
    expect(text).toContain("/api/careers/apply");
    expect(text).toContain("/api/careers/jobs?site=");
  });

  it("emits JobPosting schema, which is the point of the module", async () => {
    const { text } = await body(careersScript);
    expect(text).toContain("application/ld+json");
    expect(text).toContain("JobPosting");
    expect(text).toContain("TELECOMMUTE");
  });

  it("escapes interpolated job data", async () => {
    const { text } = await body(careersScript);
    // Every field rendered into innerHTML goes through esc().
    expect(text).toContain("function esc(v)");
    expect(text).toContain("esc(j.title)");
  });

  it("guards against mounting twice", async () => {
    const { text } = await body(careersScript);
    expect(text).toContain("__crawlproofCareersMounted");
  });
});

describe("/stats.js careers hook", () => {
  it("still serves parseable JavaScript after the careers addition", async () => {
    const { text } = await body(statsScript);
    expect(() => new Function(text)).not.toThrow();
  });

  it("lazy-loads the careers module rather than bundling it", async () => {
    const { text } = await body(statsScript);
    expect(text).toContain("/careers.js");
    expect(text).toContain("__crawlproofCareers");
  });

  // The cost discipline that makes this acceptable on every page of every
  // customer site: no fetch, no work, unless the page looks like a careers page.
  it("gates the load on a container or the careers path", async () => {
    const { text } = await body(statsScript);
    expect(text).toContain("data-cp-careers");
    expect(text).toContain("'/careers'");
    expect(text).not.toContain("/api/careers/jobs");
  });

  it("honours the documented opt-outs", async () => {
    const { text } = await body(statsScript);
    expect(text).toContain("dataset.careers === 'off'");
    expect(text).toContain("dataset.careersPath");
  });

  it("keeps tracking working", async () => {
    const { text } = await body(statsScript);
    expect(text).toContain("/api/track");
    expect(text).toContain("pageview");
  });
});
