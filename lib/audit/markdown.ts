import type { AuditResult, Finding } from "./types";

// Render a canonical Markdown report for the AEO audit. The document is
// designed as a *fix prompt* — paste-ready for an LLM coding assistant
// (Claude, GPT-5, Cursor, …) which will then apply the prioritized fixes
// to the user's site. Section numbering matches SECTIONS in prompt.ts.

function company(target: string): string {
  try {
    const u = new URL(target);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return target;
  }
}

function statusEmoji(s: Finding["status"]) {
  switch (s) {
    case "pass":
      return "✅";
    case "warn":
      return "⚠️";
    case "fail":
      return "❌";
    default:
      return "❓";
  }
}

function bySection(findings: Finding[], section: string) {
  return findings
    .filter((f) => f.section === section)
    .sort((a, b) => a.priority - b.priority);
}

function bullet(f: Finding): string {
  const head = `${statusEmoji(f.status)} **${f.title}**`;
  const body = f.detail ? `\n  ${f.detail.split("\n").join("\n  ")}` : "";
  return `- ${head}${body}`;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function preamble(targetUrl: string): string {
  return [
    `<!--`,
    `Instructions for the AI assistant reading this document:`,
    ``,
    `This is an Answer Engine Optimization (AEO) audit of ${targetUrl}.`,
    `Treat it as a TODO list. Apply the prioritized fixes from sections 13`,
    `(Recommended Fixes) and 14 (Priority To-Do List) to the user's codebase,`,
    `starting with P1 items and working down. For each fix:`,
    ``,
    `  1. Identify the file(s) in the user's repo that render the affected`,
    `     markup or headers.`,
    `  2. Make the smallest change that resolves the issue.`,
    `  3. Show the user a diff before applying.`,
    ``,
    `Skip items the user has already addressed. Group changes into logical`,
    `commits (e.g. "add security headers", "broaden schema").`,
    `-->`,
    ``,
  ].join("\n");
}

export function toMarkdown(input: {
  targetUrl: string;
  score: number;
  result: AuditResult;
}): string {
  const { targetUrl, score, result } = input;
  const { findings, summary } = result;
  const comp = company(targetUrl);

  const dataRows = summary.dataFound
    .map(
      (d) =>
        `| ${escapeCell(d.dataPoint)} | ${d.found ? "Yes" : "No"} | ${escapeCell(
          d.source ?? "—",
        )} | ${escapeCell(d.notes ?? "—")} |`,
    )
    .join("\n");

  const section = (name: string) => {
    const items = bySection(findings, name);
    if (items.length === 0) return "_No findings._";
    return items.map(bullet).join("\n");
  };

  const todo = findings
    .filter((f) => f.section === "Priority To-Do List")
    .sort((a, b) => a.priority - b.priority)
    .map(
      (f) =>
        `- [ ] **P${f.priority}** — ${f.title.replace(/^\[\s?\]\s*/, "")}${
          f.detail ? `\n      ${f.detail.split("\n").join("\n      ")}` : ""
        }`,
    )
    .join("\n");

  return [
    preamble(targetUrl),
    `# AEO Audit for ${comp}`,
    ``,
    `**Target:** ${targetUrl}  `,
    `**Score:** ${score} / 100  `,
    `**Generated:** ${new Date().toISOString()}  `,
    `**Pages crawled:** ${summary.pagesCrawled}  `,
    `**Findings:** ${summary.pass} pass · ${summary.warn} warn · ${summary.fail} fail · ${summary.unknown} unknown`,
    ``,
    `---`,
    ``,
    `## 1. Crawl Summary`,
    ``,
    section("Crawl Summary"),
    ``,
    `## 2. Data Found`,
    ``,
    `| Data Point | Found? | Source | Notes |`,
    `|---|---:|---|---|`,
    dataRows || `| _none_ | — | — | — |`,
    ``,
    `## 3. Homepage Audit`,
    ``,
    section("Homepage Audit"),
    ``,
    `## 4. Content Quality`,
    ``,
    section("Content Quality"),
    ``,
    `## 5. Schema / Structured Data Audit`,
    ``,
    section("Schema / Structured Data Audit"),
    ``,
    `## 6. Links & Images`,
    ``,
    section("Links & Images"),
    ``,
    `## 7. Performance`,
    ``,
    section("Performance"),
    ``,
    `## 8. Security`,
    ``,
    section("Security"),
    ``,
    `## 9. robots.txt and sitemap.xml Audit`,
    ``,
    section("robots.txt and sitemap.xml Audit"),
    ``,
    `## 10. LLM / AI Crawler Accessibility`,
    ``,
    section("LLM / AI Crawler Accessibility"),
    ``,
    `## 11. Positioning Clarity`,
    ``,
    section("Positioning Clarity"),
    ``,
    `## 12. Missing or Hard-to-Find Information`,
    ``,
    section("Missing or Hard-to-Find Information"),
    ``,
    `## 13. Recommended Fixes`,
    ``,
    section("Recommended Fixes"),
    ``,
    `## 14. Priority To-Do List`,
    ``,
    todo || `_No outstanding tasks. Nice work._`,
    ``,
    `---`,
    ``,
    `_Report by [CrawlProof](https://crawlproof.com). Reusable after every major website change._`,
    ``,
  ].join("\n");
}
