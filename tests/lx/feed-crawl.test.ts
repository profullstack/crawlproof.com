import { describe, expect, it } from "vitest";
import { topicFor } from "@/lib/lx/feedCrawl";
import { ago } from "@/lib/lx/feedCrawlStats";

describe("topicFor", () => {
  it("uses the first meaningful token of a multi-word subject", () => {
    // "merchant account payments" is not a directory topic; "merchant" is.
    expect(topicFor("merchant account payments")).toBe("merchant");
  });

  it("keeps a short subject that the token floor would otherwise drop", () => {
    // These are exactly the high-value subjects — four of the five that had
    // never produced a keyword were short words. Losing them here would
    // reintroduce the same blind spot one layer down.
    expect(topicFor("iptv")).toBe("iptv");
    expect(topicFor("weed")).toBe("weed");
  });

  it("slugs punctuation rather than emitting an unfetchable path", () => {
    expect(topicFor("high-risk")).toBe("high");
  });

  it("returns null for a subject with nothing in it", () => {
    expect(topicFor("   ")).toBeNull();
    expect(topicFor("!!!")).toBeNull();
  });
});

describe("ago", () => {
  const now = Date.parse("2026-08-28T12:00:00.000Z");

  it("reports never for a source that has not been read", () => {
    expect(ago(null, now)).toBe("never");
  });

  it.each([
    ["2026-08-28T11:45:00.000Z", "15m ago"],
    ["2026-08-28T09:00:00.000Z", "3h ago"],
    ["2026-08-26T12:00:00.000Z", "2d ago"],
    ["2026-08-28T11:59:45.000Z", "just now"],
  ])("formats %j as %j", (iso, expected) => {
    expect(ago(iso, now)).toBe(expected);
  });

  it("does not render a negative age when a clock is ahead", () => {
    // Worker and web can be on different hosts; "-3m ago" reads as a bug in
    // the page rather than a skewed clock, so it is clamped.
    expect(ago("2026-08-28T12:03:00.000Z", now)).toBe("just now");
  });
});
