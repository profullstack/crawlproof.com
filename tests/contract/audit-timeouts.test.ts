import { describe, expect, it } from "vitest";
import {
  CLAUDE_AUDIT_STUCK_AFTER_MS,
  DEFAULT_AUDIT_STUCK_AFTER_MS,
  PERPLEXITY_AUDIT_STUCK_AFTER_MS,
  auditStuckAfterMinutes,
  auditStuckAfterMs,
} from "@/lib/audit/timeouts";

describe("audit stuck timeout policy", () => {
  it("keeps the default stuck sweep at seven minutes", () => {
    expect(auditStuckAfterMs("rule")).toBe(DEFAULT_AUDIT_STUCK_AFTER_MS);
    expect(auditStuckAfterMinutes("rule")).toBe(7);
  });

  it("gives Claude a longer watchdog budget than the default engines", () => {
    expect(auditStuckAfterMs("claude")).toBe(CLAUDE_AUDIT_STUCK_AFTER_MS);
    expect(auditStuckAfterMs("claude")).toBeGreaterThan(auditStuckAfterMs("rule"));
    expect(auditStuckAfterMinutes("claude")).toBe(15);
  });

  // Perplexity runs a 5-minute header timeout x 2 attempts (Sonar searches
  // the web before it answers). The 7-minute default would reap a healthy
  // run mid-way through the second attempt.
  it("outlasts Perplexity's worst-case retry budget", () => {
    expect(auditStuckAfterMs("perplexity")).toBe(PERPLEXITY_AUDIT_STUCK_AFTER_MS);
    expect(auditStuckAfterMinutes("perplexity")).toBe(15);
    const perplexityWorstCaseMs = 2 * 5 * 60 * 1000;
    expect(DEFAULT_AUDIT_STUCK_AFTER_MS).toBeLessThan(perplexityWorstCaseMs);
    expect(auditStuckAfterMs("perplexity")).toBeGreaterThan(perplexityWorstCaseMs);
  });

  it("falls back to the default for unknown persisted engine names", () => {
    expect(auditStuckAfterMs("legacy-engine")).toBe(DEFAULT_AUDIT_STUCK_AFTER_MS);
  });
});
