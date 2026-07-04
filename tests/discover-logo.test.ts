import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverLogoUrl } from "@/lib/discoverLogo";

const PAGE = "https://example.com/";

// Build a fake fetch keyed by URL. `images` maps an absolute image URL to the
// status/content-type it should return; anything else 404s.
function stubFetch(html: string, images: Record<string, { status: number; ct?: string }>) {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    if (url === PAGE) {
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
        body: null, // fetchHead falls back to res.text()
        text: async () => html,
      } as unknown as Response;
    }
    const img = images[url];
    if (img) {
      return {
        ok: img.status < 400,
        status: img.status,
        url,
        headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? img.ct ?? "image/png" : null) },
        body: { cancel: async () => {} },
      } as unknown as Response;
    }
    return { ok: false, status: 404, url, headers: { get: () => null }, body: { cancel: async () => {} } } as unknown as Response;
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("discoverLogoUrl", () => {
  it("skips a broken candidate and returns the next one that actually loads", async () => {
    const html = `<head>
      <link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
      <link rel="icon" href="/favicon.ico">
    </head>`;
    // Apple icon (highest weight) 404s; favicon.ico is valid.
    stubFetch(html, {
      "https://example.com/apple.png": { status: 404 },
      "https://example.com/favicon.ico": { status: 200, ct: "image/x-icon" },
    });
    expect(await discoverLogoUrl(PAGE)).toBe("https://example.com/favicon.ico");
  });

  it("prefers the highest-weight icon when it loads", async () => {
    const html = `<head>
      <link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
      <link rel="icon" href="/favicon.ico">
    </head>`;
    stubFetch(html, {
      "https://example.com/apple.png": { status: 200, ct: "image/png" },
      "https://example.com/favicon.ico": { status: 200, ct: "image/x-icon" },
    });
    expect(await discoverLogoUrl(PAGE)).toBe("https://example.com/apple.png");
  });

  it("returns null when no candidate resolves to an image", async () => {
    const html = `<head><link rel="icon" href="/favicon.ico"></head>`;
    stubFetch(html, {}); // everything 404s, including /favicon.ico
    expect(await discoverLogoUrl(PAGE)).toBeNull();
  });

  it("accepts an image served with a generic content-type by extension", async () => {
    const html = `<head><link rel="icon" href="/logo.svg"></head>`;
    stubFetch(html, {
      "https://example.com/logo.svg": { status: 200, ct: "application/octet-stream" },
      "https://example.com/favicon.ico": { status: 404 },
    });
    expect(await discoverLogoUrl(PAGE)).toBe("https://example.com/logo.svg");
  });
});
