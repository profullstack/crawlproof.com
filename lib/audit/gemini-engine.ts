import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "../env";
import type { Finding } from "./types";
import { SECTIONS, DATA_POINTS } from "./prompt";
import type { ClaudeAuditResult } from "./claude-engine";

// Gemini engine: uses Gemini 2.5 Pro with Google Search grounding for live web
// research. Gemini's structured-output (responseSchema) doesn't combine well
// with the googleSearch tool — when both are enabled, the API rejects or
// returns text anyway. So we use grounding for the research, instruct the
// model to return ONLY JSON, then parse + Zod-validate the response.

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

const SCHEMA_DESC = `{
  "score": number,         // 0..100
  "summary": {
    "pass": number, "warn": number, "fail": number, "unknown": number,
    "dataFound": [{ "dataPoint": string, "found": boolean, "source": string | null, "notes": string | null }]
  },
  "findings": [{ "section": string, "check_key": string, "status": "pass"|"warn"|"fail"|"unknown", "title": string, "detail": string?, "priority": number(1..5) }],
  "markdown": string       // the complete report
}`;

const SYSTEM_PROMPT = `You are CrawlProof, an AEO (Answer Engine Optimization) auditor. Analyze websites the way an LLM crawler — GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended, CCBot — would discover and read them.

Use Google Search grounding to research the target. Look at the homepage, /robots.txt, /sitemap.xml, /llms.txt, /skill.md, and About/Pricing/Blog/Contact pages. Search for press, social profiles, recent news.

Produce a structured AEO audit. Findings must be assigned to one of these exact section names:
${SECTIONS.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

Data Found must cover ALL of these data points (mark found:false if you couldn't find it):
${DATA_POINTS.map((d) => `  - ${d}`).join("\n")}

For each finding:
- section: exact section name from the list above
- check_key: short snake_case (e.g. "homepage.h1", "schema.organization", "aibot.GPTBot")
- status: "pass" | "warn" | "fail" | "unknown"
- title: short headline that quotes specifics from this site
- detail: one sentence with the WHY plus actual evidence
- priority: 1 (critical) to 5 (polish)

For score: weigh critical fails heavily. Missing schema, blocked AI bots, JS-only content → below 50. Clean instrumentation → 80+.

For markdown: produce the complete report in Markdown with the 10 numbered section headers exactly. Use ✅ / ⚠️ / ❌ / ❓ emojis on each bullet. Include a Markdown "Data Found" table. Section 10 must be reusable checkboxes ("- [ ] **P1** Add JSON-LD Organization schema").

OUTPUT FORMAT: Return ONLY a single JSON object matching this schema (no prose, no fences):
${SCHEMA_DESC}

If you wrap the JSON in \`\`\`json\`\`\` fences I will strip them — but prefer raw JSON.`;

function stripJsonFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

export async function geminiAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  if (!env.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set — cannot run Gemini audit.");
  }
  const started = Date.now();
  const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });
  const company = (() => {
    try {
      return new URL(targetUrl).hostname.replace(/^www\./, "");
    } catch {
      return targetUrl;
    }
  })();

  const userPrompt = `Audit this URL: ${targetUrl}\nCompany name (for the report header): ${company}\n\nPretend you've never heard of this company. Use Google Search to fetch pages and any public references.`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-pro",
    contents: userPrompt,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ googleSearch: {} }],
      // Larger budget — JSON output + markdown can run long.
      maxOutputTokens: 24000,
    },
  });

  const raw = (response.text ?? "").trim();
  if (!raw) {
    throw new Error("Gemini returned an empty response.");
  }

  let json: unknown;
  try {
    json = JSON.parse(stripJsonFences(raw));
  } catch (err) {
    throw new Error(
      `Gemini returned non-JSON output: ${(err as Error).message}. First 200 chars: ${raw.slice(0, 200)}`,
    );
  }
  const parsed = ResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Gemini output failed schema validation: ${parsed.error.message}`,
    );
  }

  const data = parsed.data;
  const findings: Finding[] = data.findings.map((f) => ({
    section: f.section,
    check_key: f.check_key,
    status: f.status,
    title: f.title,
    detail: f.detail ?? undefined,
    evidence: undefined,
    priority: Math.min(5, Math.max(1, Math.round(f.priority))) as Finding["priority"],
  }));

  return {
    score: Math.round(Math.max(0, Math.min(100, data.score))),
    findings,
    summary: {
      pagesCrawled: 0,
      pass: data.summary.pass,
      warn: data.summary.warn,
      fail: data.summary.fail,
      unknown: data.summary.unknown,
      dataFound: data.summary.dataFound,
      durationMs: Date.now() - started,
    },
    markdown: data.markdown,
  };
}
