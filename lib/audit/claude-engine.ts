import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The SDK's zod helper imports from "zod/v4" internally and calls
// z.toJSONSchema() — a v4-only API. Importing plain "zod" here gives us v3
// schemas whose `_def` shape v4 can't read, producing the
// "Cannot read properties of undefined (reading 'def')" crash at runtime.
import { z } from "zod/v4";
import { env } from "../env";
import type { AuditResult, Finding } from "./types";
import { SECTIONS, DATA_POINTS } from "./prompt";

// Schema Claude must populate. Numeric/string constraints (min/max/length)
// aren't supported by structured outputs — we validate them client-side.
const FindingSchema = z.object({
  section: z.string(),
  check_key: z.string(),
  status: z.enum(["pass", "warn", "fail", "unknown"]),
  title: z.string(),
  detail: z.string().optional(),
  priority: z.number().int(),
});

const ResultSchema = z.object({
  score: z.number(),
  summary: z.object({
    pass: z.number(),
    warn: z.number(),
    fail: z.number(),
    unknown: z.number(),
    dataFound: z.array(
      z.object({
        dataPoint: z.string(),
        found: z.boolean(),
        source: z.string().nullable(),
        notes: z.string().nullable(),
      }),
    ),
  }),
  findings: z.array(FindingSchema),
  markdown: z.string(),
});

const SYSTEM_PROMPT = `You are CrawlProof, an AEO (Answer Engine Optimization) auditor. You analyze websites the way an LLM crawler — GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended, CCBot — would discover and read them.

For every audit:
1. Use \`web_fetch\` on the target URL (homepage).
2. Use \`web_fetch\` on each well-known file: /robots.txt, /sitemap.xml, /llms.txt, /llms-full.txt, /skill.md, /.well-known/ai-plugin.json. Some will 404 — that's a finding.
3. Use \`web_fetch\` on up to 6 important linked pages found in the homepage nav/footer: /about, /pricing, /blog, /docs, /contact, /team, /customers, /security, /features, /changelog. Skip ones that don't exist on this site.
4. Optionally \`web_search\` for additional public context (press, social profiles, recent news).

Then produce a structured AEO audit. Findings must be assigned to one of these exact section names:
${SECTIONS.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

Data Found must cover ALL of these data points (mark found:false if you couldn't find it):
${DATA_POINTS.map((d) => `  - ${d}`).join("\n")}

For each finding:
- section: exact section name from the list above
- check_key: short snake_case identifier (e.g. "homepage.h1", "schema.organization", "aibot.GPTBot", "positioning.cta", "llms_txt.exists")
- status: "pass" | "warn" | "fail" | "unknown"
- title: short headline that quotes specifics from this site (not generic)
- detail: one sentence with the WHY plus the specific evidence (e.g. the actual H1 text, the actual robots.txt line)
- priority: 1 (critical, breaks AEO entirely) to 5 (polish)

For the "AI Recognition" section, BEFORE doing any web_fetch / web_search, answer honestly from your own training data:
- Do you recognize this company / domain from training? (status: "pass" if yes with substantive recall, "warn" if vague, "fail" if not at all, "unknown" if uncertain)
- check_key: "recognition.training_data"
- title: "Familiar with <domain>" or "No prior knowledge of <domain>"
- detail: One sentence. If you recognize it, name 1–2 concrete things you remember (what they do, who they serve, notable products). If you don't, say so plainly — do NOT speculate or paraphrase web search results.
- priority: 3 (informational signal, not a defect)

This section is a signal of training-data presence, not a quality judgment. Sites that don't appear in training can still be excellent — but the user should know whether they're invisible to the dominant AI surfaces.

For score: weigh critical fails heavily. A site missing schema, blocking GPTBot in robots.txt, or hiding all content behind JS should score below 50. A clean, well-instrumented site should score 80+.

For summary.pass/warn/fail/unknown: count each across all findings.

For markdown: produce the complete report in Markdown with these exact section headers:
# AEO Audit for {{domain}}

**Target:** {url}
**Score:** {N} / 100
**Generated:** ISO timestamp

## 1. Crawl Summary
## 2. Data Found
(Use a Markdown table here: | Data Point | Found? | Source | Notes |)
## 3. Homepage Audit
## 4. Schema / Structured Data Audit
## 5. robots.txt and sitemap.xml Audit
## 6. LLM / AI Crawler Accessibility
## 7. AI Recognition
(One paragraph stating whether you recognize this site from training data, and what specifically you remember if so. No fluff.)
## 8. Positioning Clarity
## 9. Missing or Hard-to-Find Information
## 10. Recommended Fixes
## 11. Priority To-Do Checklist

Use ✅ / ⚠️ / ❌ / ❓ status emojis on each bullet. Quote actual content from the site. Section 10 must be reusable checkboxes ("- [ ] **P1** Add JSON-LD Organization schema").

Tone: direct, specific, no fluff. This is a paid report — quality matters.`;

export type ClaudeAuditResult = AuditResult & { markdown: string };

export async function claudeAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  if (!env.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set — cannot run paid audit.");
  }
  const started = Date.now();
  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  const company = (() => {
    try {
      return new URL(targetUrl).hostname.replace(/^www\./, "");
    } catch {
      return targetUrl;
    }
  })();

  const userPrompt = `Audit this URL: ${targetUrl}\nCompany name (for the report header): ${company}\n\nPretend you've never heard of this company. Use only the public web. Use web_fetch and web_search.`;

  // Stream the request — high-effort adaptive thinking + web tools routinely
  // pushes past the SDK's 10-minute non-streaming HTTP timeout. `.finalMessage()`
  // gives us the same ParsedMessage shape `.parse()` did.
  const stream = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      format: zodOutputFormat(ResultSchema as any),
    },
    tools: [
      { type: "web_search_20260209", name: "web_search" },
      { type: "web_fetch_20260209", name: "web_fetch" },
    ],
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: userPrompt }],
  });
  const response = await stream.finalMessage();

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(
      `Claude audit failed: stop_reason=${response.stop_reason ?? "unknown"}, no parsed output. ` +
        `Refusal: ${response.stop_details?.explanation ?? "n/a"}`,
    );
  }

  const findings: Finding[] = parsed.findings.map((f: z.infer<typeof FindingSchema>) => ({
    section: f.section,
    check_key: f.check_key,
    status: f.status,
    title: f.title,
    detail: f.detail ?? undefined,
    evidence: undefined,
    priority: Math.min(5, Math.max(1, Math.round(f.priority))) as Finding["priority"],
  }));

  return {
    score: Math.round(Math.max(0, Math.min(100, parsed.score))),
    findings,
    summary: {
      pagesCrawled: 0,
      pass: parsed.summary.pass,
      warn: parsed.summary.warn,
      fail: parsed.summary.fail,
      unknown: parsed.summary.unknown,
      dataFound: parsed.summary.dataFound,
      durationMs: Date.now() - started,
    },
    markdown: parsed.markdown,
  };
}
