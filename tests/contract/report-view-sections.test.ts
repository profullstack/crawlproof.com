import { describe, expect, it } from "vitest";
import { reportSections } from "@/components/report/report-view";
import type { Finding } from "@/lib/audit/types";

const finding = (section: string): Finding => ({
  section,
  check_key: section.toLowerCase().replace(/[^a-z0-9]+/g, "."),
  status: "warn",
  title: section,
  priority: 3,
});

describe("reportSections", () => {
  it("renders DNS as the visible section for DNS Analyzer reports", () => {
    expect(reportSections([finding("DNS")], "dns")).toEqual(["DNS"]);
  });

  it("renders link checker findings without all AEO placeholder sections", () => {
    expect(reportSections([finding("Links & Images")], "links")).toEqual([
      "Links & Images",
    ]);
  });

  it("keeps canonical AEO sections and appends unknown sections for normal reports", () => {
    const sections = reportSections([finding("DNS")], "claude");
    expect(sections).toContain("Homepage Audit");
    expect(sections.at(-1)).toBe("DNS");
  });
});
