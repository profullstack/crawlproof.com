import { describe, it, expect } from "vitest";
import { parseCookies } from "@/lib/sp/platforms/browser";

const ALLOWED = new Set(["Strict", "Lax", "None"]);

describe("parseCookies sameSite normalization", () => {
  it("maps Chrome/Cookie-Editor sameSite spellings to Playwright's enum", () => {
    const raw = JSON.stringify([
      { name: "a", value: "1", domain: "x.com", sameSite: "no_restriction" },
      { name: "b", value: "2", domain: "x.com", sameSite: "lax" },
      { name: "c", value: "3", domain: "x.com", sameSite: "strict" },
      { name: "d", value: "4", domain: "x.com", sameSite: "unspecified" },
      { name: "e", value: "5", domain: "x.com", sameSite: null },
      { name: "f", value: "6", domain: "x.com" }, // missing entirely
    ]);
    const cookies = parseCookies(raw);
    expect(cookies.map((c) => c.sameSite)).toEqual([
      "None",
      "Lax",
      "Strict",
      "Lax",
      "Lax",
      "Lax",
    ]);
    // Every value is one Playwright accepts.
    for (const c of cookies) expect(ALLOWED.has(c.sameSite!)).toBe(true);
  });

  it("forces Secure on SameSite=None cookies (Chromium rejects otherwise)", () => {
    const raw = JSON.stringify([
      { name: "n", value: "1", domain: "x.com", sameSite: "no_restriction", secure: false },
      { name: "l", value: "2", domain: "x.com", sameSite: "lax", secure: false },
    ]);
    const [none, lax] = parseCookies(raw);
    expect(none.secure).toBe(true);
    expect(lax.secure).toBe(false);
  });

  it("accepts already-correct capitalized values and cookie-wrapper JSON", () => {
    const raw = JSON.stringify({
      cookies: [{ name: "a", value: "1", domain: "x.com", sameSite: "None", secure: true }],
    });
    const [c] = parseCookies(raw);
    expect(c.sameSite).toBe("None");
    expect(c.secure).toBe(true);
  });
});
