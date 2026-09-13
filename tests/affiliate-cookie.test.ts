import { describe, expect, it } from "vitest";
import { decodeCookie, encodeCookie, expiresAt, isNavigation, withinWindow } from "@/lib/affiliate/cookie";

describe("attribution cookie", () => {
  it("round-trips", () => {
    const at = new Date("2026-09-13T12:00:00Z");
    const v = encodeCookie({ code: "anthony", clickedAt: at });
    expect(v).toBe("anthony.1789300800");
    expect(decodeCookie(v)).toEqual({ code: "anthony", clickedAt: at });
  });
  it("refuses garbage", () => {
    expect(decodeCookie("")).toBeNull();
    expect(decodeCookie("anthony")).toBeNull();
    expect(decodeCookie("Bad.1789344000")).toBeNull();
    expect(decodeCookie("anthony.-5")).toBeNull();
    expect(decodeCookie("anthony.notanumber")).toBeNull();
  });
  it("window arithmetic", () => {
    const at = new Date("2026-09-01T00:00:00Z");
    expect(expiresAt(at, 30).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(withinWindow(at, 30, new Date("2026-09-30T23:59:00Z"))).toBe(true);
    expect(withinWindow(at, 30, new Date("2026-10-01T00:00:01Z"))).toBe(false);
    // a click from the future is not a click
    expect(withinWindow(new Date("2026-09-02T00:00:00Z"), 30, at)).toBe(false);
  });
});

describe("isNavigation", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
  it("only a document navigation sets attribution", () => {
    expect(isNavigation(h({ "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }))).toBe(true);
    expect(isNavigation(h({ "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" }))).toBe(false);
    expect(isNavigation(h({ "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" }))).toBe(false);
    expect(isNavigation(h({ "sec-fetch-dest": "script", "sec-fetch-mode": "no-cors" }))).toBe(false);
    expect(isNavigation(h({ "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }))).toBe(false);
  });
  it("falls back to Accept when the fetch metadata headers are absent", () => {
    expect(isNavigation(h({ accept: "text/html,application/xhtml+xml" }))).toBe(true);
    expect(isNavigation(h({ accept: "image/webp,*/*" }))).toBe(false);
    expect(isNavigation(h({}))).toBe(false);
  });
});
