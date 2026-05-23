import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { OPTIONS, POST } from "@/app/api/track/route";

describe("/api/track CORS", () => {
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
});
