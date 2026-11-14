import { describe, expect, it } from "vitest";

import { parseBotHits } from "@/lib/tracker/botHits";

describe("parseBotHits", () => {
  it("merges rows by bucket and path and strips query strings", () => {
    const r = parseBotHits({
      site: "nichedb.dev",
      hits: [
        { bucket: "bot:swarm", path: "/i/1?x=1", count: 3 },
        { bucket: "bot:swarm", path: "/i/1", count: 2 },
        { bucket: "bot:swarm", path: "/c/x", count: 1 },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.site).toBe("nichedb.dev");
    expect(r.hits).toEqual([
      { bucket: "bot:swarm", path: "/i/1", count: 5 },
      { bucket: "bot:swarm", path: "/c/x", count: 1 },
    ]);
  });

  it("only ever writes bot buckets", () => {
    expect(parseBotHits({ hits: [{ bucket: "human:direct", path: "/", count: 1 }] }).ok).toBe(false);
    expect(parseBotHits({ hits: [{ bucket: "search:google", path: "/", count: 1 }] }).ok).toBe(false);
  });

  it("refuses bad counts and empty batches", () => {
    expect(parseBotHits({ hits: [] }).ok).toBe(false);
    expect(parseBotHits({ hits: [{ bucket: "bot:swarm", path: "/", count: 0 }] }).ok).toBe(false);
    expect(parseBotHits({ hits: [{ bucket: "bot:swarm", path: "/", count: 1.5 }] }).ok).toBe(false);
    expect(parseBotHits({ hits: [{ bucket: "bot:swarm", path: "/", count: 2_000_000 }] }).ok).toBe(false);
  });

  it("defaults a missing or relative path to /", () => {
    const r = parseBotHits({ hits: [{ bucket: "bot:swarm", count: 1 }, { bucket: "bot:swarm", path: "http://x/y", count: 1 }] });
    expect(r.ok && r.hits).toEqual([{ bucket: "bot:swarm", path: "/", count: 2 }]);
  });
});

describe("siteHost", async () => {
  const { siteHost } = await import("@/lib/tracker/botHits");
  it("normalises hostnames and URLs", () => {
    expect(siteHost("nichedb.dev")).toBe("nichedb.dev");
    expect(siteHost("https://www.RSSamp.com/x")).toBe("rssamp.com");
    expect(siteHost("")).toBe(null);
  });
});
