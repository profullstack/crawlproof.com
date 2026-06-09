import { describe, expect, it } from "vitest";
import {
  APPLY_FIX_MODEL,
  buildApplyFixUserPrompt,
} from "@/lib/github/apply-fix";

const finding = {
  check_key: "schema.organization",
  section: "Schema / Structured Data Audit",
  priority: 2,
  title: "Missing Organization schema",
  detail: "No Organization JSON-LD was found.",
  evidence: { source: "homepage" },
};

describe("apply-fix prompt", () => {
  it("uses Opus 4.8 for PR fix generation", () => {
    expect(APPLY_FIX_MODEL).toBe("claude-opus-4-8");
  });

  it("includes optional user PR guidance when provided", () => {
    const prompt = buildApplyFixUserPrompt({
      finding,
      targetUrl: "https://example.com",
      defaultBranch: "main",
      projectId: "project-123",
      auditId: "audit-456",
      auditEngine: "claude",
      repoFullName: "acme/site",
      rootPath: "apps/web",
      userPrompt:
        "use Profullstack.com, Profullstack, Inc. for all company references",
    });

    expect(prompt).toContain("You are Claude Opus 4.8");
    expect(prompt).toContain("- Target site: https://example.com");
    expect(prompt).toContain("- Project ID: project-123");
    expect(prompt).toContain("- Audit ID: audit-456");
    expect(prompt).toContain("- Audit engine: claude");
    expect(prompt).toContain("- Repository: acme/site");
    expect(prompt).toContain("- Default branch: main");
    expect(prompt).toContain(
      "Repository root hint: the site code likely lives under `apps/web`",
    );
    expect(prompt).toContain("Additional user guidance for this PR:");
    expect(prompt).toContain(
      "use Profullstack.com, Profullstack, Inc. for all company references",
    );
    expect(prompt).toContain("Explore the repository before editing");
  });

  it("omits the guidance block when no guidance is provided", () => {
    const prompt = buildApplyFixUserPrompt({
      finding,
      targetUrl: "https://example.com",
      defaultBranch: "main",
    });

    expect(prompt).not.toContain("Additional user guidance for this PR:");
  });

  it("returns an edited full prompt exactly after trimming", () => {
    const prompt = buildApplyFixUserPrompt({
      finding,
      targetUrl: "https://example.com",
      defaultBranch: "main",
      prompt: "\n\nUse this exact custom PR instruction.\n\n",
    });

    expect(prompt).toBe("Use this exact custom PR instruction.");
  });

  it("falls back to the generated default prompt when an edited prompt is blank", () => {
    const prompt = buildApplyFixUserPrompt({
      finding,
      targetUrl: "https://example.com",
      defaultBranch: "main",
      prompt: "   ",
    });

    expect(prompt).toContain("You are Claude Opus 4.8");
    expect(prompt).toContain("- Check key: schema.organization");
  });
});
