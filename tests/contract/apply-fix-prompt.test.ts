import { describe, expect, it } from "vitest";
import { buildApplyFixUserPrompt } from "@/lib/github/apply-fix";

const finding = {
  check_key: "schema.organization",
  section: "Schema / Structured Data Audit",
  priority: 2,
  title: "Missing Organization schema",
  detail: "No Organization JSON-LD was found.",
  evidence: { source: "homepage" },
};

describe("apply-fix prompt", () => {
  it("includes optional user PR guidance when provided", () => {
    const prompt = buildApplyFixUserPrompt({
      finding,
      targetUrl: "https://example.com",
      defaultBranch: "main",
      userPrompt:
        "use Profullstack.com, Profullstack, Inc. for all company references",
    });

    expect(prompt).toContain("Additional user guidance for this PR:");
    expect(prompt).toContain(
      "use Profullstack.com, Profullstack, Inc. for all company references",
    );
  });

  it("omits the guidance block when no guidance is provided", () => {
    const prompt = buildApplyFixUserPrompt({
      finding,
      targetUrl: "https://example.com",
      defaultBranch: "main",
    });

    expect(prompt).not.toContain("Additional user guidance for this PR:");
  });
});
