import { describe, it, expect } from "vitest";
import {
  PIXEL_GIF,
  looksLikePrefetch,
  newTrackToken,
  pixelHtml,
  pixelUrl,
} from "@/lib/outreach/openTracking";

const SENT = new Date("2026-07-28T12:00:00Z");
const later = (ms: number) => new Date(SENT.getTime() + ms);

describe("the pixel itself", () => {
  it("is a real GIF", () => {
    // A malformed image is a broken-image box in a stranger's inbox.
    expect(PIXEL_GIF.subarray(0, 6).toString("ascii")).toBe("GIF89a");
  });

  it("is small enough to be free", () => {
    expect(PIXEL_GIF.length).toBeLessThan(100);
  });

  it("renders as an invisible, unannounced image", () => {
    const html = pixelHtml("https://x.test/api/o/abc.gif");
    // A screen reader announcing "image" mid-email would give the tracking
    // away to exactly the readers least able to avoid it.
    expect(html).toContain('alt=""');
    expect(html).toContain('role="presentation"');
    expect(html).toContain("width=\"1\"");
  });

  it("mints a token that is not guessable from the last one", () => {
    const a = newTrackToken();
    const b = newTrackToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("builds a URL that reads as an image", () => {
    expect(pixelUrl("https://x.test", "abc")).toBe("https://x.test/api/o/abc.gif");
  });
});

describe("telling a person from a proxy", () => {
  it("counts a plausible human open", () => {
    expect(
      looksLikePrefetch({
        userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15",
        sentAt: SENT,
        now: later(4 * 3600_000),
      }),
    ).toBe(false);
  });

  it("discards Gmail's image cache", () => {
    expect(
      looksLikePrefetch({
        userAgent: "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko GoogleImageProxy",
        sentAt: SENT,
        now: later(4 * 3600_000),
      }),
    ).toBe(true);
  });

  it("discards a fetch that beats the recipient to the message", () => {
    // Nobody receives, notices and opens an email in two seconds often enough
    // to matter; a caching proxy does it every time.
    expect(looksLikePrefetch({ userAgent: "Mozilla/5.0", sentAt: SENT, now: later(2000) })).toBe(
      true,
    );
  });

  it("discards a fetch that appears to predate its own email", () => {
    // Clock skew between sender and receiver, not evidence of anything.
    expect(looksLikePrefetch({ userAgent: "Mozilla/5.0", sentAt: SENT, now: later(-5000) })).toBe(
      true,
    );
  });

  it("discards a client that identifies itself as nothing", () => {
    expect(looksLikePrefetch({ userAgent: null, sentAt: SENT, now: later(3600_000) })).toBe(true);
    expect(looksLikePrefetch({ userAgent: "", sentAt: SENT, now: later(3600_000) })).toBe(true);
  });

  it("discards link-preview bots", () => {
    // A forwarded email pasted into Slack fetches every image in it.
    for (const ua of ["Slackbot-LinkExpanding 1.0", "facebookexternalhit/1.1", "WhatsApp/2.0"]) {
      expect(looksLikePrefetch({ sentAt: SENT, now: later(3600_000), userAgent: ua })).toBe(true);
    }
  });

  it("errs towards discarding", () => {
    // An understated open rate is survivable. An inflated one keeps somebody
    // sending into a void because the numbers looked fine.
    const suspicious = ["Microsoft Office Outlook", "Barracuda", "Mimecast", "Proofpoint"];
    for (const ua of suspicious) {
      expect(looksLikePrefetch({ sentAt: SENT, now: later(3600_000), userAgent: ua })).toBe(true);
    }
  });
});
