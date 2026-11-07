import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ args: [] as any[], answer: null as null | (() => unknown) }));

vi.mock("@/lib/lx/backendAi", () => ({
  hasBackendAiTextProvider: () => true,
  generateStructuredOutput: async (args: unknown) => {
    calls.args.push(args);
    return calls.answer!();
  },
}));
vi.mock("@/lib/env", () => ({ env: { anthropicApiKey: "", openaiApiKey: "" } }));
vi.mock("@/lib/audit/dns", () => ({
  collectDnsRecords: async () => ({ domain: "example.com", a: [], aaaa: [], mx: [], ns: [], txt: [], dkim: [] }),
  dnsBaselineFindings: () => [
    { section: "DNS", check_key: "dns.inventory", status: "pass", title: "Inventory", priority: 5 },
  ],
}));

import { dnsAudit } from "@/lib/audit/dns-engine";

describe("dnsAudit AI step", () => {
  beforeEach(() => {
    calls.args = [];
  });

  it("runs with no paid key and takes c0mpute's answer", async () => {
    calls.answer = () => ({
      provider: "c0mpute",
      output: {
        score: 80,
        findings: [{ check_key: "spf", status: "warn", title: "SPF is soft", priority: 2 }],
        markdown: "# DNS",
      },
    });
    const result = await dnsAudit("https://example.com");
    expect(calls.args).toHaveLength(1);
    expect(calls.args[0].anthropic).toBeNull();
    expect(result.score).toBe(80);
    expect(result.findings.map((f) => f.check_key)).toEqual(["dns.inventory", "dns.spf"]);
  });

  it("keeps the deterministic baseline when every provider fails", async () => {
    calls.answer = () => {
      throw new Error("Backend AI generation failed");
    };
    const result = await dnsAudit("https://example.com");
    expect(result.findings.map((f) => f.check_key)).toEqual(["dns.inventory"]);
  });
});
