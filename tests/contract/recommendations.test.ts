import { describe, it, expect } from "vitest";
import { deriveRecommendations } from "@/lib/audit/recommendations";
import type { Finding } from "@/lib/audit/types";

const F = (over: Partial<Finding> = {}): Finding => ({
  section: "Homepage Audit",
  check_key: "homepage.h1",
  status: "fail",
  title: "Missing H1",
  priority: 1,
  ...over,
});

describe("deriveRecommendations", () => {
  it("emits no rec for pass findings", () => {
    const recs = deriveRecommendations([F({ status: "pass" })]);
    expect(recs).toHaveLength(0);
  });

  it("emits a rec for a fail finding with a known check_key", () => {
    const recs = deriveRecommendations([F({ status: "fail", check_key: "homepage.h1" })]);
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toMatch(/H1/);
    expect(recs[0].how.length).toBeGreaterThan(20);
  });

  it("templates a recommendation for any aibot.* finding", () => {
    const recs = deriveRecommendations([
      F({
        section: "LLM / AI Crawler Accessibility",
        check_key: "aibot.GPTBot",
        status: "fail",
        title: "GPTBot blocked",
      }),
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toMatch(/GPTBot/);
    expect(recs[0].how).toMatch(/User-agent: GPTBot/);
  });

  it("ignores check_keys with no template", () => {
    const recs = deriveRecommendations([F({ check_key: "completely.unknown.key" })]);
    expect(recs).toHaveLength(0);
  });

  it("sorts by priority ascending (P1 first)", () => {
    const recs = deriveRecommendations([
      F({ priority: 5, status: "warn", check_key: "homepage.alt_text" }),
      F({ priority: 1, status: "fail", check_key: "homepage.h1" }),
      F({ priority: 3, status: "warn", check_key: "homepage.canonical" }),
    ]);
    expect(recs.map((r) => r.priority)).toEqual([1, 3, 5]);
  });
});
