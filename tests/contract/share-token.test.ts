import { describe, it, expect } from "vitest";
import { newShareToken } from "@/lib/shareToken";

describe("newShareToken", () => {
  it("returns a url-safe base64 token of the expected length", () => {
    const t = newShareToken();
    expect(typeof t).toBe("string");
    expect(t.length).toBeGreaterThanOrEqual(20);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is unique across many calls (no birthday collisions on 100 samples)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(newShareToken());
    expect(seen.size).toBe(100);
  });
});
