import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The SDK's zod helper imports from "zod/v4" internally and calls
// z.toJSONSchema() — a v4-only API. Importing plain "zod" here gives us v3
// schemas whose `_def` shape v4 can't read, producing the
// "Cannot read properties of undefined (reading 'def')" crash at runtime.
import { z } from "zod/v4";
import { env } from "../env";
import type { AuditResult, Finding } from "./types";
import { SECTIONS, buildAEOUserPrompt } from "./prompt";
import { buildSiteContext } from "./page-context";

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

// Minimal system prompt — task content lives in buildAEOUserPrompt so every
// engine sends the same canonical AEO spec as its USER turn. System only
// covers identity, tool guidance specific to Claude, and the JSON output
// schema that messages.parse needs to populate.
const SYSTEM_PROMPT = `You are CrawlProof, an AEO (Answer Engine Optimization) auditor — you analyze websites the way an LLM crawler (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended, CCBot) would discover and read them.

The user message contains the audit spec followed by pre-fetched public site content (homepage, well-known files, and high-signal linked pages). Use that context as the source of truth. If a file 404'd or is missing, report that as a finding.

Follow the user's spec exactly for the report structure and Markdown output. Quote actual content from the site — don't paraphrase. Section ${SECTIONS.length} must be reusable checkboxes (\`- [ ] **P1** Add JSON-LD Organization schema\`). Use ✅ / ⚠️ / ❌ / ❓ status emojis throughout. Tone: direct, specific, no fluff.

Findings JSON must match one of these exact section names:
${SECTIONS.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

For each finding:
- section: exact section name above
- check_key: short snake_case identifier (e.g. \`homepage.h1\`, \`schema.organization\`, \`aibot.GPTBot\`, \`positioning.cta\`, \`llms_txt.exists\`)
- status: \`pass\` | \`warn\` | \`fail\` | \`unknown\`
- title: short headline quoting specifics from this site
- detail: one sentence with the WHY plus actual evidence (the H1 text, the robots.txt line, etc.)
- priority: 1 (critical — breaks AEO) to 5 (polish)

For score: critical fails dominate. Missing schema, blocking GPTBot, JS-only content → below 50. Clean instrumentation → 80+. For summary.pass/warn/fail/unknown: count each across all findings.`;

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

  const aeoTask = buildAEOUserPrompt({ targetUrl, companyName: company });
  const context = await buildSiteContext(targetUrl);

  // Stream the request so slow output still keeps the HTTP connection active.
  // Claude previously used agentic web_fetch/web_search tools, which turned
  // one scan into many model/tool round trips and routinely ran past the
  // worker's seven-minute stuck sweep. The bounded pre-fetch keeps discovery
  // deterministic and makes Claude do a single structured-output pass.
  // Sonnet 4.6 defaults to higher reasoning; keep thinking disabled and
  // effort medium so it still audits without spending time on extended
  // reasoning.
  console.log(
    `[claude] calling claude-sonnet-4-6 (${context.length} chars context)`,
  );
  const stream = client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 32000,
    thinking: { type: "disabled" },
    output_config: {
      effort: "medium",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      format: zodOutputFormat(ResultSchema as any),
    },
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: `${aeoTask}\n\n---\n\nPre-fetched public site content:\n\n${context}`,
      },
    ],
  });
  const response = await stream.finalMessage();
  console.log(
    `[claude] claude-sonnet-4-6 returned in ${Date.now() - started}ms`,
  );

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
