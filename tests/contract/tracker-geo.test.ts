import { describe, expect, it } from "vitest";
import { clientIpFromHeaders, lookupGeo } from "@/lib/tracker/geo";

describe("tracker geo lookup", () => {
  it("extracts the first forwarded public IP", () => {
    const headers = new Headers({
      "x-forwarded-for": "8.8.8.8, 10.0.0.1",
    });

    expect(clientIpFromHeaders(headers)).toBe("8.8.8.8");
  });

  it("skips private proxy IPs before forwarded public IPs", () => {
    const headers = new Headers({
      "x-real-ip": "10.0.0.12",
      "x-forwarded-for": "192.168.1.25, 8.8.8.8",
    });

    expect(clientIpFromHeaders(headers)).toBe("8.8.8.8");
  });

  it("ignores local and private addresses", async () => {
    await expect(lookupGeo("127.0.0.1")).resolves.toBeNull();
    await expect(lookupGeo("10.0.0.1")).resolves.toBeNull();
    await expect(lookupGeo("192.168.1.1")).resolves.toBeNull();
  });

  it("looks up public IP locations from the bundled database", async () => {
    const geo = await lookupGeo("8.8.8.8");

    expect(geo?.countryCode).toBe("US");
    expect(geo?.timezone).toBeTruthy();
  });
});
