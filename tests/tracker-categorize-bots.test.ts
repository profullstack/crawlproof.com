import { describe, expect, it } from "vitest";
import { categorize, isStaleBrowser } from "@/lib/tracker/categorize";

const OCT_2026 = Date.UTC(2026, 9, 17);
const chrome = (v: number) =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
const firefox = (v: number) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;

describe("headless engines", () => {
  it("calls Lightpanda a bot", () => {
    expect(categorize({ referrer: null, userAgent: "Lightpanda/1.0" }).bucket).toBe("bot:headless");
  });

  it("calls scripted HTTP clients bots", () => {
    for (const ua of ["python-requests/2.32", "Go-http-client/2.0", "curl/8.5.0", "node-fetch/1.0", "axios/1.7.2"]) {
      expect(categorize({ referrer: null, userAgent: ua }).bucket).toBe("bot:headless");
    }
  });
});

describe("stale browsers", () => {
  it("flags Chrome and Firefox about two years out of date", () => {
    expect(isStaleBrowser(chrome(119), OCT_2026)).toBe(true);
    expect(isStaleBrowser(chrome(120), OCT_2026)).toBe(true);
    expect(isStaleBrowser(firefox(121), OCT_2026)).toBe(true);
  });

  it("leaves current and recent browsers alone", () => {
    expect(isStaleBrowser(chrome(151), OCT_2026)).toBe(false);
    expect(isStaleBrowser(chrome(140), OCT_2026)).toBe(false);
    expect(isStaleBrowser(firefox(140), OCT_2026)).toBe(false); // ESR
    expect(
      isStaleBrowser(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
        OCT_2026,
      ),
    ).toBe(false);
  });

  it("flags a UA still wrapped in quotes", () => {
    expect(isStaleBrowser(`"${chrome(151)}"`, OCT_2026)).toBe(true);
  });

  it("moves with the calendar instead of rotting", () => {
    expect(isStaleBrowser(chrome(140), Date.UTC(2029, 0, 1))).toBe(true);
  });

  it("buckets a stale browser as bot:stale_ua", () => {
    expect(categorize({ referrer: "https://www.google.com/", userAgent: chrome(110) }).bucket).toBe("bot:stale_ua");
  });

  it("still lets a current browser through to referrer bucketing", () => {
    expect(categorize({ referrer: "https://www.google.com/", userAgent: chrome(152) }).bucket).toBe("search:google");
    expect(categorize({ referrer: null, userAgent: chrome(152) }).bucket).toBe("human:direct");
  });
});
