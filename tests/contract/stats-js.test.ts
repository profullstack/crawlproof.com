import { describe, expect, it } from "vitest";
import { GET } from "@/app/stats.js/route";

describe("/stats.js", () => {
  it("sends tracking requests without browser credentials", async () => {
    const response = await GET();
    const script = await response.text();

    expect(script).toContain("credentials: 'omit'");
    expect(script).toContain("mode: 'no-cors'");
    expect(script).not.toContain("sendBeacon");
  });
});
