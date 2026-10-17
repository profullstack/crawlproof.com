import { describe, it, expect } from "vitest";
import { buildTodoList, deriveRecommendations } from "@/lib/audit/recommendations";
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

describe("buildTodoList", () => {
  const TARGET = "https://example.com/";
  const base: Finding[] = [
    F({ section: "Homepage Audit", check_key: "homepage.h1", status: "pass", priority: 1 }),
    F({
      section: "Links & Images",
      check_key: "links.broken_sample",
      status: "fail",
      title: "2 broken link(s) in first 20",
      detail: "· 503 — https://example.com/pricing\n· timeout — https://cdn.example.net/x.js",
      evidence: { sampled: 20, broken: 2, examples: [] },
      priority: 1,
    }),
    F({ section: "Security", check_key: "security.hsts", status: "warn", title: "HSTS missing", priority: 3 }),
    F({ section: "Security", check_key: "security.xcto", status: "warn", title: "X-Content-Type-Options missing", priority: 4 }),
    F({ section: "robots.txt and sitemap.xml Audit", check_key: "robots.sitemap_ref", status: "fail", title: "No Sitemap line", priority: 2 }),
  ];

  it("turns each broken link into its own step naming the URL and status", () => {
    const steps = buildTodoList(base, TARGET).map((t) => t.step);
    expect(steps).toContain("Fix https://example.com/pricing (returns 503)");
    expect(steps).toContain("Fix https://cdn.example.net/x.js (timed out)");
  });

  it("names the exact header and value to add", () => {
    const hsts = buildTodoList(base, TARGET).find((t) => t.check_key === "security.hsts")!;
    expect(hsts.step).toBe("Add header Strict-Transport-Security: max-age=31536000; includeSubDomains");
    expect(hsts.value).toBe("Strict-Transport-Security: max-age=31536000; includeSubDomains");
    const xcto = buildTodoList(base, TARGET).find((t) => t.check_key === "security.xcto")!;
    expect(xcto.step).toBe("Add header X-Content-Type-Options: nosniff");
  });

  it("uses the audited site's own URLs", () => {
    const robots = buildTodoList(base, TARGET).find((t) => t.check_key === "robots.sitemap_ref")!;
    expect(robots.step).toBe('Add the line "Sitemap: https://example.com/sitemap.xml" to https://example.com/robots.txt');
  });

  it("orders by score impact, highest first, and every step is imperative", () => {
    const todo = buildTodoList(base, TARGET);
    const points = todo.map((t) => t.points);
    expect([...points].sort((a, b) => b - a)).toEqual(points);
    expect(todo[todo.length - 1]!.check_key).toBe("security.xcto");
    for (const t of todo) expect(t.step).toMatch(/^(Add|Fix|Allow|Create|Publish|Remove|Stop|Serve|Load|Set|Use|Make|Rewrite|State|Reduce|Eliminate|Externalize|Review|Speed|Declare|Raise|Phrase|Lazy-load|Generate|Complete|Server-render|Populate|Reference|Enable|Define)\b/);
  });

  it("ignores rec.* and todo.* rows already stored with the audit", () => {
    const stored = [...base, F({ section: "Priority To-Do List", check_key: "todo.security.hsts", status: "warn", priority: 3 })];
    expect(buildTodoList(stored, TARGET)).toHaveLength(buildTodoList(base, TARGET).length);
  });
});
