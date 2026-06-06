import { describe, expect, it } from "vitest";
import { recipientHash } from "@/lib/outreach";

describe("outreach utilities", () => {
  it("hashes recipients case-insensitively and trims whitespace", () => {
    expect(recipientHash("  Lead@Example.com ")).toBe(recipientHash("lead@example.com"));
  });

  it("does not collapse different recipients into the same hash", () => {
    expect(recipientHash("one@example.com")).not.toBe(recipientHash("two@example.com"));
  });
});
