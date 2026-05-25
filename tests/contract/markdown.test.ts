import { describe, it, expect } from "vitest";
import { toMarkdown } from "@/lib/audit/markdown";
import { markdownToHtml, htmlDocument } from "@/lib/markdown";
import type { AuditResult, Finding } from "@/lib/audit/types";

const sampleResult: AuditResult = {
  score: 78,
  findings: [
    {
      section: "Homepage Audit",
      check_key: "homepage.h1",
      status: "pass",
      title: "Single H1",
      detail: "Hello world",
      priority: 5,
    },
    {
      section: "Homepage Audit",
      check_key: "homepage.title",
      status: "fail",
      title: "Missing <title>",
      detail: "Add a title tag.",
      priority: 1,
    },
    {
      section: "Recommended Fixes",
      check_key: "rec.homepage.title",
      status: "warn",
      title: "Set a meaningful <title>",
      detail: "50–60 chars, brand first.",
      priority: 1,
    },
    {
      section: "Priority To-Do List",
      check_key: "todo.homepage.title",
      status: "warn",
      title: "[ ] Set a meaningful <title>",
      detail: "50–60 chars, brand first.",
      priority: 1,
    },
  ] as Finding[],
  summary: {
    pagesCrawled: 3,
    pass: 5,
    warn: 2,
    fail: 1,
    unknown: 0,
    dataFound: [
      { dataPoint: "Pricing", found: true, source: "Pricing page", notes: "/pricing" },
      { dataPoint: "Executive team", found: false, source: null, notes: null },
    ],
    durationMs: 12000,
  },
};

describe("toMarkdown", () => {
  const md = toMarkdown({
    targetUrl: "https://example.com",
    score: 78,
    result: sampleResult,
  });

  it("emits the audit header with target + score", () => {
    expect(md).toMatch(/^# AEO Audit for/m);
    expect(md).toContain("https://example.com");
    expect(md).toContain("**Score:** 78 / 100");
  });

  it("includes all 14 numbered section headers in order", () => {
    const positions = [
      "## 1. Crawl Summary",
      "## 2. Data Found",
      "## 3. Homepage Audit",
      "## 4. Content Quality",
      "## 5. Schema / Structured Data Audit",
      "## 6. Links & Images",
      "## 7. Performance",
      "## 8. Security",
      "## 9. robots.txt and sitemap.xml Audit",
      "## 10. LLM / AI Crawler Accessibility",
      "## 11. Positioning Clarity",
      "## 12. Missing or Hard-to-Find Information",
      "## 13. Recommended Fixes",
      "## 14. Priority To-Do List",
    ].map((h) => md.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    // strictly ascending
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it("includes a fix-prompt preamble addressed to an AI assistant", () => {
    expect(md).toMatch(/<!--[\s\S]*Instructions for the AI assistant/);
    expect(md).toContain("https://example.com");
  });

  it("includes a Markdown Data Found table with the right columns", () => {
    expect(md).toContain("| Data Point | Found? | Source | Notes |");
    expect(md).toMatch(/\|\s*Pricing\s*\|\s*Yes\s*\|/);
    expect(md).toMatch(/\|\s*Executive team\s*\|\s*No\s*\|/);
  });

  it("uses ✅ / ⚠️ / ❌ status emojis on findings", () => {
    expect(md).toMatch(/✅.*Single H1/);
    expect(md).toMatch(/❌.*Missing <title>/);
  });

  it("renders the priority to-do as a checkbox list with P-labels", () => {
    expect(md).toMatch(/- \[ \] \*\*P1\*\*/);
  });
});

describe("markdownToHtml + htmlDocument", () => {
  it("converts a minimal Markdown document to HTML (marked fallback works)", async () => {
    const html = await markdownToHtml("# Hello\n\n- one\n- two\n");
    expect(html).toContain("<h1");
    expect(html).toContain("Hello");
    expect(html).toMatch(/<li[^>]*>one<\/li>/);
  });

  it("keeps in-page anchor links in the same browsing context", async () => {
    const html = await markdownToHtml(
      '## Table of contents\n- <a href="#intro" target="_blank" rel="noopener">Intro</a>\n\n## Intro\n',
    );
    expect(html).toContain('href="#intro"');
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain('rel="noopener"');
  });

  it("htmlDocument escapes the title and embeds the body", () => {
    const out = htmlDocument({
      title: "Test <script>alert(1)</script>",
      bodyHtml: "<p>Body content</p>",
    });
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toMatch(/<title>[^<]*<script>/);
    expect(out).toContain("<p>Body content</p>");
  });

  it("htmlDocument with meta includes score ring + target", () => {
    const out = htmlDocument({
      title: "Audit",
      bodyHtml: "<p>x</p>",
      meta: {
        target: "https://example.com",
        score: 82,
        generatedAt: "2026-05-12T00:00:00.000Z",
      },
    });
    expect(out).toContain("https://example.com");
    expect(out).toContain(">82<");
    expect(out).toContain("class=\"score-ring\"");
  });

  it("decorates status emojis into pill spans in the body", () => {
    const out = htmlDocument({
      title: "x",
      bodyHtml: "<p>✅ pass · ⚠️ warn · ❌ fail · ❓ unknown</p>",
    });
    expect(out).toContain("class=\"pill pill-pass\">PASS<");
    expect(out).toContain("class=\"pill pill-warn\">WARN<");
    expect(out).toContain("class=\"pill pill-fail\">FAIL<");
    expect(out).toContain("class=\"pill pill-unknown\">?<");
  });
});
