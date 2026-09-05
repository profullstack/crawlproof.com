import { describe, expect, it } from "vitest";

import { assertPublicTarget, isPrivateAddress, PrivateTargetError } from "@/lib/net-guard";
import { paidFetch, x402 } from "@/lib/paid-fetch";

describe("net-guard", () => {
  it("knows private address space", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "104.18.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });

  it("refuses loopback, private and metadata targets before any request", async () => {
    for (const url of ["http://127.0.0.1:1/", "http://localhost:3000/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/admin"]) {
      await expect(assertPublicTarget(url), url).rejects.toBeInstanceOf(PrivateTargetError);
    }
  });

  it("accepts a public address", async () => {
    await expect(assertPublicTarget("https://1.1.1.1/")).resolves.toBeUndefined();
  });
});

describe("paidFetch", () => {
  it("is the plain fetch when no key is configured", () => {
    expect(x402).toBeNull();
  });

  it("never connects to a private target", async () => {
    // Port 1 on loopback: if the guard were missing this would be a
    // connection error, not a PrivateTargetError.
    await expect(paidFetch("http://127.0.0.1:1/")).rejects.toBeInstanceOf(PrivateTargetError);
  });
});
