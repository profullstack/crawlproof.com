import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { env } from "../env";
import type { AuditResult, Finding } from "./types";
import { SECTIONS, DATA_POINTS } from "./prompt";
import type { ClaudeAuditResult } from "./claude-engine";

// OpenAI scan — same JSON shape as the Claude engine so the worker stores
// findings identically and the dashboard charts keep working. Uses the
// Responses API with the built-in web_search_preview tool so GPT-5 can
// research the target like the Claude engine does.

// OpenAI structured outputs reject `.optional()` without `.nullable()` — every
// field has to be in the required set, and absence is expressed as null.
const FindingSchema = z.object({
  section: z.string(),
  check_key: z.string(),
  status: z.enum(["pass", "warn", "fail", "unknown"]),
  title: z.string(),
  detail: z.string().nullable(),
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

const SYSTEM_PROMPT = `You are CrawlProof, an AEO (Answer Engine Optimization) auditor. Analyze websites the way an LLM crawler — GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended, CCBot — would discover and read them.

Use the web_search tool to research the target. Pull the homepage, /robots.txt, /sitemap.xml, /llms.txt, /skill.md, and any About/Pricing/Blog/Contact pages you can find. Search for press, social profiles, and recent news as needed.

Produce a structured AEO audit. Findings must be assigned to one of these exact section names:
${SECTIONS.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

Data Found must cover ALL of these data points (mark found:false if you couldn't find it):
${DATA_POINTS.map((d) => `  - ${d}`).join("\n")}

For each finding:
- section: exact section name from the list above
- check_key: short snake_case (e.g. "homepage.h1", "schema.organization", "aibot.GPTBot")
- status: "pass" | "warn" | "fail" | "unknown"
- title: short headline that quotes specifics from this site
- detail: one sentence with the WHY plus actual evidence (the H1 text, the robots.txt line, etc.)
- priority: 1 (critical) to 5 (polish)

For score: weigh critical fails heavily. Missing schema, blocking GPTBot, hiding content behind JS = score below 50. Clean instrumentation = 80+.

For markdown: produce the complete report following the section structure exactly. Use ✅ / ⚠️ / ❌ / ❓ status emojis. Include a "Data Found" markdown table in section 2. Section 10 must be reusable checkboxes ("- [ ] **P1** Add JSON-LD Organization schema").

Tone: direct, specific, no fluff. This is a paid report.`;

export async function openaiAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not set — cannot run OpenAI audit.");
  }
  const started = Date.now();
  const client = new OpenAI({ apiKey: env.openaiApiKey });
  const company = (() => {
    try {
      return new URL(targetUrl).hostname.replace(/^www\./, "");
    } catch {
      return targetUrl;
    }
  })();

  const userPrompt = `Audit this URL: ${targetUrl}\nCompany name (for the report header): ${company}\n\nPretend you've never heard of this company. Use only the public web. Use web_search to fetch pages.`;

  const response = await client.responses.parse({
    model: "gpt-5",
    instructions: SYSTEM_PROMPT,
    input: userPrompt,
    tools: [{ type: "web_search_preview" }],
    text: {
      format: zodTextFormat(ResultSchema, "aeo_audit"),
    },
  });

  const parsed = response.output_parsed;
  if (!parsed) {
    throw new Error(
      `OpenAI audit returned no parsed output (status=${response.status ?? "?"}).`,
    );
  }

  const findings: Finding[] = parsed.findings.map((f) => ({
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

export type AuditResultPaid = AuditResult & { markdown: string };
