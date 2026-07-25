import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { env } from "../env";
import type { AuditResult, Finding } from "./types";
import { SECTIONS, buildAEOUserPrompt } from "./prompt";
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

// Identity + tool guidance + JSON schema only. The canonical AEO task lives
// in buildAEOUserPrompt and is sent as the USER turn, identical across
// every LLM engine.
const SYSTEM_PROMPT = `You are CrawlProof, an AEO (Answer Engine Optimization) auditor — you analyze websites the way an LLM crawler (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended, CCBot) would discover and read them.

Use the web_search tool to research the target. Pull the homepage, /robots.txt, /sitemap.xml, /llms.txt, /skill.md, and any About/Pricing/Blog/Contact pages you can find. Search for press, social profiles, and recent news as needed.

Follow the user's spec exactly for the report structure and Markdown output. Quote actual content from the site — don't paraphrase. Section ${SECTIONS.length} must be reusable checkboxes (\`- [ ] **P1** Add JSON-LD Organization schema\`). Use ✅ / ⚠️ / ❌ / ❓ emojis throughout. Tone: direct, specific, no fluff.

Findings JSON must match one of these exact section names:
${SECTIONS.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

For each finding:
- section: exact section name above
- check_key: short snake_case (e.g. \`homepage.h1\`, \`schema.organization\`, \`aibot.GPTBot\`)
- status: \`pass\` | \`warn\` | \`fail\` | \`unknown\`
- title: short headline quoting specifics from this site
- detail: one sentence with the WHY plus actual evidence
- priority: 1 (critical) to 5 (polish)

For score: critical fails dominate. Missing schema, blocking GPTBot, JS-only content → below 50. Clean instrumentation → 80+.`;

/**
 * A 429 from this engine is almost always `insufficient_quota` — the shared
 * OPENAI_API_KEY ran out of billing credit — not a per-minute limit. The raw
 * SDK text ("You exceeded your current quota…") reads like throttling and
 * sends people to the Retry button, which can never succeed.
 */
function explainOpenAIError(err: unknown): unknown {
  if (err instanceof OpenAI.APIError && err.status === 429) {
    const code = String((err as { code?: string }).code ?? "");
    if (code === "insufficient_quota" || /quota|billing/i.test(err.message)) {
      return new Error(
        "OpenAI rejected the request (HTTP 429): the OPENAI_API_KEY account is out of API credit, not rate-limited. Top up billing at platform.openai.com — retrying won't help.",
      );
    }
    return new Error(
      `OpenAI rate-limited the request (HTTP 429). Wait and retry. Provider said: ${err.message}`,
    );
  }
  return err;
}

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

  const userPrompt = buildAEOUserPrompt({ targetUrl, companyName: company });

  // gpt-5-mini for speed — gpt-5 with web_search_preview routinely
  // took 10–20 min. Mini handles the AEO classification task fine and
  // brings wall time down to 2–4 min while keeping live web research.
  // Explicit reasoning.effort=medium so it doesn't default to a
  // minimal reasoning pass and emit a zero-finding shell (same trap
  // Claude hit at effort=low).
  // .catch() rather than try/catch so the parsed-output generic still
  // flows through from zodTextFormat — annotating `let response` erases it.
  const response = await client.responses
    .parse({
      model: "gpt-5-mini",
      instructions: SYSTEM_PROMPT,
      input: userPrompt,
      tools: [{ type: "web_search_preview" }],
      reasoning: { effort: "medium" },
      text: {
        format: zodTextFormat(ResultSchema, "aeo_audit"),
      },
    })
    .catch((err: unknown) => {
      throw explainOpenAIError(err);
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
