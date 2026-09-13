import { describe, expect, it } from "vitest";
import { checkUrlShape, isPrivateAddress } from "@/lib/affiliate/ssrf";
import { cookieFromHeader } from "@/lib/affiliate/cookie";

describe("isPrivateAddress", () => {
  it("blocks every range a merchant URL must never reach", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fd12::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "224.0.0.1", "255.255.255.255"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "104.18.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("treats a non-address as private", () => {
    expect(isPrivateAddress("nope")).toBe(true);
  });
});

describe("checkUrlShape", () => {
  it("accepts a public https origin", () => {
    expect(checkUrlShape("https://nichedb.dev/.well-known/openaffiliate.json")).toMatchObject({ ok: true });
    expect(checkUrlShape("http://example.com:80/")).toMatchObject({ ok: true });
  });
  it("refuses what cannot be a merchant", () => {
    expect(checkUrlShape("ftp://example.com")).toMatchObject({ ok: false });
    expect(checkUrlShape("https://user:pw@example.com")).toMatchObject({ ok: false, error: "credentials in the URL" });
    expect(checkUrlShape("https://example.com:8443/")).toMatchObject({ ok: false, error: "non-standard port" });
    expect(checkUrlShape("https://localhost/")).toMatchObject({ ok: false });
    expect(checkUrlShape("https://db.internal/")).toMatchObject({ ok: false });
    expect(checkUrlShape("https://railway/")).toMatchObject({ ok: false });
    expect(checkUrlShape("https://127.0.0.1/")).toMatchObject({ ok: false, error: "private address" });
    expect(checkUrlShape("https://[::1]/")).toMatchObject({ ok: false, error: "private address" });
    expect(checkUrlShape("https://169.254.169.254/latest/meta-data")).toMatchObject({ ok: false });
    expect(checkUrlShape("not a url")).toMatchObject({ ok: false });
  });
});

describe("cookieFromHeader", () => {
  it("finds the cookie among others and decodes it", () => {
    expect(cookieFromHeader("a=1; oa=anthony.1789300800; b=2")).toBe("anthony.1789300800");
    expect(cookieFromHeader("oa=anthony.1789300800")).toBe("anthony.1789300800");
    expect(cookieFromHeader("oa=a%2Eb")).toBe("a.b");
    expect(cookieFromHeader("oab=x; xoa=y")).toBeNull();
    expect(cookieFromHeader(null)).toBeNull();
  });
});
