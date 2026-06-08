import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MultiEngineReportView,
  type MultiEngineAuditRow,
} from "@/components/report/report-view";
import type { Finding } from "@/lib/audit/types";

const audit = (
  id: string,
  engine: string,
  summary: MultiEngineAuditRow["summary"],
): MultiEngineAuditRow => ({
  id,
  target_url: "https://example.com",
  status: "complete",
  score: 80,
  summary,
  completed_at: "2026-06-08T00:00:00.000Z",
  created_at: "2026-06-08T00:00:00.000Z",
  engine,
});

const finding = (
  section: string,
  title: string,
  check_key: string,
): Finding => ({
  section,
  check_key,
  status: "warn",
  title,
  priority: 2,
});

describe("MultiEngineReportView", () => {
  it("renders every engine and each engine's analysis sections", () => {
    const findingsByAuditId = new Map<string, Finding[]>([
      [
        "rule-audit",
        [
          finding(
            "Homepage Audit",
            "Homepage content is thin",
            "homepage.content",
          ),
        ],
      ],
      ["dns-audit", [finding("DNS", "DMARC policy is missing", "dns.dmarc")]],
    ]);

    const html = renderToStaticMarkup(
      createElement(MultiEngineReportView, {
        audits: [
          audit("rule-audit", "rule", { pass: 1, warn: 1, fail: 0 }),
          audit("dns-audit", "dns", { pass: 2, warn: 1, fail: 0 }),
        ],
        findingsByAuditId,
      }),
    );

    expect(html).toContain("Multi-engine AEO audit");
    expect(html).toContain("Rule-based");
    expect(html).toContain("DNS Analyzer");
    expect(html).toContain("Homepage Audit");
    expect(html).toContain("Homepage content is thin");
    expect(html).toContain("DNS");
    expect(html).toContain("DMARC policy is missing");
  });
});
