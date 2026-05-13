import OpenAI from "openai";
import { z } from "zod";
import { fetchPage, probeText } from "./fetch";
import { SECTIONS, DATA_POINTS } from "./prompt";
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

const SYSTEM_PROMPT = `You are CrawlProof, an AEO (Answer Engine Optimization) auditor. Analyze the website content the user provides — homepage HTML and well-known files — the way an LLM crawler (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot-Extended, CCBot) would discover and read it.

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

For markdown: produce the complete report in Markdown with the 10 numbered headers exactly. Use ✅ / ⚠️ / ❌ / ❓ emojis on each bullet. Include a Markdown "Data Found" table. Section 10 must be reusable checkboxes ("- [ ] **P1** Add JSON-LD Organization schema").

OUTPUT FORMAT: Return ONLY a single JSON object matching this schema (no prose, no fences):
${SCHEMA_DESC}`;

const PAGE_LIMIT_BYTES = 60_000;
const PRIORITY_PATHS = [
  "/about",
  "/pricing",
  "/blog",
  "/docs",
  "/contact",
  "/team",
  "/customers",
  "/security",
];

function trim(s: string | undefined | null, max = PAGE_LIMIT_BYTES): string {
  if (!s) return "(missing)";
  return s.length > max ? s.slice(0, max) + "\n…(truncated)…" : s;
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

async function buildContext(targetUrl: string): Promise<string> {
  const u = new URL(targetUrl);
  const origin = u.origin;
  const [home, robots, sitemap, llms, skill] = await Promise.all([
    fetchPage(targetUrl),
    probeText(`${origin}/robots.txt`),
    probeText(`${origin}/sitemap.xml`),
    probeText(`${origin}/llms.txt`),
    probeText(`${origin}/skill.md`),
  ]);

  // Discover up to 4 priority linked pages from the homepage.
  const linked: { url: string; rawHtml: string }[] = [];
  if (home.rawHtml) {
    const candidates = PRIORITY_PATHS.map((p) => new URL(p, origin).toString())
      .filter((href) => home.rawHtml.toLowerCase().includes(new URL(href).pathname))
      .slice(0, 4);
    const fetched = await Promise.all(candidates.map((c) => fetchPage(c)));
    for (const f of fetched) if (f.status === 200 && f.rawHtml) linked.push(f);
  }

  return [
    `Target: ${targetUrl}`,
    ``,
    `=== Homepage (HTTP ${home.status}, ${home.bytes} bytes) ===`,
    trim(home.rawHtml),
    ``,
    `=== /robots.txt (${robots?.status ?? "n/a"}) ===`,
    trim(robots?.content, 6000),
    ``,
    `=== /sitemap.xml (${sitemap?.status ?? "n/a"}) ===`,
    trim(sitemap?.content, 8000),
    ``,
    `=== /llms.txt (${llms?.status ?? "n/a"}) ===`,
    trim(llms?.content, 4000),
    ``,
    `=== /skill.md (${skill?.status ?? "n/a"}) ===`,
    trim(skill?.content, 3000),
    ``,
    ...linked.flatMap((p) => [
      `=== Linked page ${p.url} ===`,
      trim(p.rawHtml, 20000),
      ``,
    ]),
    `Now produce the audit JSON per the schema.`,
  ].join("\n");
}

export type OACompatConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  /** Human label only used for error messages. */
  providerLabel: string;
};

export async function oaCompatAudit(
  targetUrl: string,
  cfg: OACompatConfig,
): Promise<ClaudeAuditResult> {
  if (!cfg.apiKey) {
    throw new Error(`${cfg.providerLabel} API key is not set.`);
  }
  const started = Date.now();
  const context = await buildContext(targetUrl);
  // DashScope / Moonshot occasionally stall mid-completion. The OpenAI SDK
  // default would let a job sit for ~10 minutes, blocking the credit and
  // confusing the user — cap each request and fail fast instead.
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    timeout: 4 * 60 * 1000,
    maxRetries: 1,
  });

  console.log(
    `[oa-compat:${cfg.providerLabel}] calling ${cfg.model} (${context.length} chars context)`,
  );
  const response = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: context },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 16000,
  });
  console.log(
    `[oa-compat:${cfg.providerLabel}] ${cfg.model} returned in ${Date.now() - started}ms`,
  );

  const raw = response.choices[0]?.message?.content ?? "";
  if (!raw) throw new Error(`${cfg.providerLabel} returned empty content.`);

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
