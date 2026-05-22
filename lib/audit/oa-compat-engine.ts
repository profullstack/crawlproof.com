import OpenAI from "openai";
import type { ChatCompletionCreateParams } from "openai/resources/chat/completions";
import { z } from "zod";
import { buildSiteContext } from "./page-context";
import { SECTIONS, buildAEOUserPrompt } from "./prompt";
import type { Finding } from "./types";
import type { ClaudeAuditResult } from "./claude-engine";

// Shared engine for OpenAI-compatible providers without a built-in web tool
// (Qwen via DashScope; Moonshot/Kimi). We pre-fetch the homepage + well-known
// files + up to 6 linked pages, bundle them as context, and have the model
// return strict JSON via response_format: {type:'json_object'}.

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
  "score": number,
  "summary": {
    "pass": number, "warn": number, "fail": number, "unknown": number,
    "dataFound": [{ "dataPoint": string, "found": boolean, "source": string | null, "notes": string | null }]
  },
  "findings": [{ "section": string, "check_key": string, "status": "pass"|"warn"|"fail"|"unknown", "title": string, "detail": string?, "priority": number }],
  "markdown": string
}`;

// Identity + JSON schema only. The canonical AEO task lives in
// buildAEOUserPrompt and is sent as the USER turn. We pre-fetched
// homepage + well-known files for the model since it has no tool use
// — the user prompt is followed by the fetched context block.
const SYSTEM_PROMPT = `You are CrawlProof, an AEO (Answer Engine Optimization) auditor — you analyze websites the way an LLM crawler (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended, CCBot) would discover and read them.

The user message contains the audit spec followed by pre-fetched page content (homepage HTML, /robots.txt, /sitemap.xml, /llms.txt, /skill.md, and linked pages). Use only that content — you don't have tool access. If a file 404'd it'll say so; report that as a finding.

Follow the user's spec exactly for the report structure and Markdown output. Quote actual content from the pages — don't paraphrase. Section ${SECTIONS.length} must be reusable checkboxes (\`- [ ] **P1** Add JSON-LD Organization schema\`). Use ✅ / ⚠️ / ❌ / ❓ emojis throughout. Tone: direct, specific, no fluff.

Findings JSON must match one of these exact section names:
${SECTIONS.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

For each finding:
- section: exact section name above
- check_key: short snake_case (e.g. \`homepage.h1\`, \`schema.organization\`, \`aibot.GPTBot\`)
- status: \`pass\` | \`warn\` | \`fail\` | \`unknown\`
- title: short headline quoting specifics from this site
- detail: one sentence with the WHY plus actual evidence
- priority: 1 (critical) to 5 (polish)

For score: critical fails dominate. Missing schema, blocked AI bots, JS-only content → below 50. Clean instrumentation → 80+.

OUTPUT FORMAT: Return ONLY a single JSON object matching this schema (no prose, no fences):
${SCHEMA_DESC}`;

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

export type OACompatConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  /** Human label only used for error messages. */
  providerLabel: string;
  /**
   * Max output tokens the provider will accept. Each provider has its own
   * ceiling — DashScope/Qwen rejects > 32768 with a 400; Gemini handles 65K.
   * Must be large enough to fit the full JSON report (markdown + findings +
   * summary), which routinely needs 30K+ tokens.
   */
  maxOutputTokens: number;
  /**
   * Override the response_format the SDK sends. Most providers accept
   * `{ type: "json_object" }` (the default); Perplexity Sonar only
   * accepts `text`, `json_schema`, or `regex` and rejects `json_object`
   * with a 400.
   */
  responseFormat?: ChatCompletionCreateParams["response_format"];
  /**
   * Sampling temperature. Defaults to 0.2 for deterministic-ish
   * audit output. Kimi K2.6 rejects anything other than 1 with a 400;
   * its engine override pins it.
   */
  temperature?: number;
};

export async function oaCompatAudit(
  targetUrl: string,
  cfg: OACompatConfig,
): Promise<ClaudeAuditResult> {
  if (!cfg.apiKey) {
    throw new Error(`${cfg.providerLabel} API key is not set.`);
  }
  const started = Date.now();
  const context = await buildSiteContext(targetUrl);
  const company = (() => {
    try { return new URL(targetUrl).hostname.replace(/^www\./, ""); } catch { return targetUrl; }
  })();
  const aeoTask = buildAEOUserPrompt({ targetUrl, companyName: company });
  // DashScope / Moonshot occasionally stall mid-completion. The OpenAI SDK
  // default would let a job sit for ~10 minutes, blocking the credit and
  // confusing the user — cap each request and fail fast instead.
  // Was 4-min timeout × 5 attempts (20 min worst case) before a 149K-char
  // homepage scan caused a 10+ min stall against Kimi. Tightened to
  // 90s per attempt × 3 attempts (~4.5 min worst case) so the user sees
  // a real failure they can retry instead of an indefinite spinner.
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    timeout: 90 * 1000,
    maxRetries: 2,
  });

  console.log(
    `[oa-compat:${cfg.providerLabel}] calling ${cfg.model} (${context.length} chars context)`,
  );
  // Stream the completion. The full report (markdown + findings + summary)
  // routinely runs 60-100K characters; non-streaming with a tight max_tokens
  // would either truncate the JSON mid-property or hit the SDK HTTP timeout
  // on slow providers (DashScope/Moonshot).
  let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;
  try {
    stream = await client.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        // Canonical AEO task followed by pre-fetched site context. The system
        // prompt tells the model the second block is read-only context, not
        // a separate task.
        { role: "user", content: `${aeoTask}\n\n---\n\nPre-fetched site content:\n\n${context}` },
      ],
      response_format: cfg.responseFormat ?? { type: "json_object" },
      temperature: cfg.temperature ?? 0.2,
      max_tokens: cfg.maxOutputTokens,
      stream: true,
    });
  } catch (err) {
    if (err instanceof OpenAI.APIError && err.status === 429) {
      throw new Error(
        `${cfg.providerLabel} rate-limited the request (HTTP 429) after ${4 + 1} attempts. Provider quota is exhausted — check the API key's tier / per-minute limit.`,
      );
    }
    throw err;
  }

  let raw = "";
  let finishReason: string | null = null;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta?.content;
    if (delta) raw += delta;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  console.log(
    `[oa-compat:${cfg.providerLabel}] ${cfg.model} returned in ${Date.now() - started}ms (${raw.length} chars, finish=${finishReason ?? "?"})`,
  );

  if (!raw) throw new Error(`${cfg.providerLabel} returned empty content.`);
  if (finishReason === "length") {
    throw new Error(
      `${cfg.providerLabel} hit the output token cap (${raw.length} chars). The model didn't finish the JSON — raise max_tokens.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(stripFences(raw));
  } catch (err) {
    throw new Error(
      `${cfg.providerLabel} returned non-JSON: ${(err as Error).message}. First 200 chars: ${raw.slice(0, 200)}`,
    );
  }
  const parsed = ResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${cfg.providerLabel} output failed schema validation: ${parsed.error.message}`,
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
