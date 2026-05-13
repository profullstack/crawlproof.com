import type { AuditResult, Finding } from "./types";

// Render a canonical Markdown report matching the original audit prompt format.
// Sections are numbered 1..10 and follow the prompt's exact structure so the
// document is recognizable to anyone who used the prompt directly with an LLM.

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
    .map((f) => `- [ ] **P${f.priority}** — ${f.title.replace(/^\[\s?\]\s*/, "")}${f.detail ? `\n      ${f.detail.split("\n").join("\n      ")}` : ""}`)
    .join("\n");

  return [
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
    `## 4. Schema / Structured Data Audit`,
    ``,
    section("Schema / Structured Data Audit"),
    ``,
    `## 5. robots.txt and sitemap.xml Audit`,
    ``,
    section("robots.txt and sitemap.xml Audit"),
    ``,
    `## 6. LLM / AI Crawler Accessibility`,
    ``,
    section("LLM / AI Crawler Accessibility"),
    ``,
    `## 7. Positioning Clarity`,
    ``,
    section("Positioning Clarity"),
    ``,
    `## 8. Missing or Hard-to-Find Information`,
    ``,
    section("Missing or Hard-to-Find Information"),
    ``,
    `## 9. Recommended Fixes`,
    ``,
    section("Recommended Fixes"),
    ``,
    `## 10. Priority To-Do List`,
    ``,
    todo || `_No outstanding tasks. Nice work._`,
    ``,
    `---`,
    ``,
    `_Report by [CrawlProof](https://crawlproof.com). Reusable after every major website change._`,
    ``,
  ].join("\n");
}
