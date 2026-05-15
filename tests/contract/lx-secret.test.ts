import { describe, it, expect } from "vitest";
import { generateWebhookSecret } from "@/lib/lx/secret";

describe("generateWebhookSecret", () => {
  it("uses the cp_lx_ prefix so receivers + leak-scanners can spot it", () => {
    const s = generateWebhookSecret();
    expect(s.startsWith("cp_lx_")).toBe(true);
  });

  it("produces 32 bytes of base64url entropy after the prefix", () => {
    const s = generateWebhookSecret();
    const tail = s.slice("cp_lx_".length);
    // base64url(32 bytes) → 43 chars, no padding.
    expect(tail).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("yields a different secret on every call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) seen.add(generateWebhookSecret());
    expect(seen.size).toBe(25);
  });
});
