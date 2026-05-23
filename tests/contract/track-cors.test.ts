import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { GET, OPTIONS, POST } from "@/app/api/track/route";

const db = vi.hoisted(() => {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
  };
  return {
    chain,
    from: vi.fn(() => chain),
  };
});

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({ from: db.from }),
}));

describe("/api/track CORS", () => {
  beforeEach(() => {
    db.from.mockClear();
    db.chain.select.mockClear();
    db.chain.eq.mockClear();
    db.chain.maybeSingle.mockClear();
    db.chain.maybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it("echoes the concrete origin for credentialed browser requests", async () => {
    const request = new Request("https://crawlproof.com/api/track", {
      method: "OPTIONS",
      headers: {
        origin: "https://sh1pt.com",
        "access-control-request-headers": "content-type",
      },
    });

    const response = await OPTIONS(request as NextRequest);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://sh1pt.com",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("keeps invalid tracking payloads public and anonymous", async () => {
    const request = new Request("https://crawlproof.com/api/track", {
      method: "POST",
      body: "not json",
    });

    const response = await POST(request as NextRequest);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("keeps legacy credentialless GET tracking compatible", async () => {
    const request = new Request(
      "https://crawlproof.com/api/track?site=475e7e62-b048-44da-90b4-746d1ba512d2&event=pageview&url=https%3A%2F%2Fsh1pt.com%2F&ref=&target=&t=1",
      {
        method: "GET",
        headers: {
          origin: "https://sh1pt.com",
          referer: "https://sh1pt.com/",
          "user-agent": "Mozilla/5.0 test",
        },
      },
    );

    const response = await GET(request as NextRequest);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://sh1pt.com",
    );
    expect(db.from).toHaveBeenCalledWith("projects");
  });

  it("accepts DataFast-style JSON event posts", async () => {
    const request = new Request("https://crawlproof.com/api/track", {
      method: "POST",
      headers: {
        origin: "https://sh1pt.com",
        referer: "https://sh1pt.com/",
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 test",
      },
      body: JSON.stringify({
        websiteId: "475e7e62-b048-44da-90b4-746d1ba512d2",
        domain: "sh1pt.com",
        href: "https://sh1pt.com/",
        referrer: null,
        viewport: { width: 1920, height: 920 },
        visitorId: "vtest",
        sessionId: "stest",
        language: "en-US",
        timezone: "UTC",
        screenWidth: 1920,
        screenHeight: 1080,
        type: "pageview",
      }),
    });

    const response = await POST(request as NextRequest);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://sh1pt.com",
    );
    expect(db.from).toHaveBeenCalledWith("projects");
  });
});
