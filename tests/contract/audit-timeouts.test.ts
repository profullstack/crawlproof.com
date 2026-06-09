import { describe, expect, it } from "vitest";
import {
  CLAUDE_AUDIT_STUCK_AFTER_MS,
  DEFAULT_AUDIT_STUCK_AFTER_MS,
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

  it("falls back to the default for unknown persisted engine names", () => {
    expect(auditStuckAfterMs("legacy-engine")).toBe(DEFAULT_AUDIT_STUCK_AFTER_MS);
  });
});
