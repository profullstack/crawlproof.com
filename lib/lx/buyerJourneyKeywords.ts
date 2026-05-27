import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod/v4";
import { env } from "../env";
import { generateStructuredOutput } from "./backendAi";

const CLAUDE_KEYWORD_MODEL = "claude-haiku-4-5-20251001";

const KeywordIntent = z.enum([
  "informational",
  "commercial",
  "transactional",
  "navigational",
  "local",
]);

const ClusterType = z.enum([
  "direct_intent",
  "problem_aware",
  "alternative_solution",
  "comparison",
  "substitute",
  "diy_or_template",
  "objection_or_risk",
  "commercial_openness",
  "local_or_contextual",
  "ethical_pivot",
]);

export const BuyerJourneyKeywordOutput = z.object({
  seed_query: z.string(),
  assumed_solution: z.string(),
  underlying_problem: z.string(),
  searcher_stage: z.enum(["awareness", "consideration", "decision", "mixed"]),
  openness_signals: z.array(z.string()),
  keyword_clusters: z.array(
    z.object({
      cluster_name: z.string(),
      cluster_type: ClusterType,
      why_it_matters: z.string(),
      keywords: z.array(
        z.object({
          keyword: z.string(),
          intent: KeywordIntent,
          priority: z.number().int().min(1).max(5),
          content_angle: z.string(),
          soft_product_pivot: z.string(),
        }).strict(),
      ),
    }).strict(),
  ),
  recommended_content_assets: z.array(
    z.object({
      asset_type: z.enum([
        "blog_post",
        "comparison_page",
        "checklist",
        "template",
        "tool",
        "landing_page",
        "faq",
        "webinar",
        "case_study",
      ]),
      title: z.string(),
      target_keywords: z.array(z.string()),
      cta_style: z.enum([
        "educational",
        "soft_demo",
        "free_tool",
        "download",
        "consultation",
        "trial",
      ]),
    }).strict(),
  ),
  ethical_notes: z.array(z.string()),
}).strict();

export type BuyerJourneyKeywordOutput = z.infer<typeof BuyerJourneyKeywordOutput>;
export type BuyerJourneyKeywordIntent = z.infer<typeof KeywordIntent>;
export type BuyerJourneyClusterType = z.infer<typeof ClusterType>;

export type BuyerJourneyKeywordCandidate = {
  keyword: string;
  intent: BuyerJourneyKeywordIntent;
  priority: number;
  clusterType: BuyerJourneyClusterType;
  clusterName: string;
  contentAngle: string;
  softProductPivot: string;
};

export type BuyerJourneyKeywordInput = {
  seedQuery: string;
  additionalSeeds: string[];
  offer: string;
  audience: string;
  brand: string;
  geography: string;
  industry: string;
  competitors: string[];
  tone?: string | null;
};

export const BUYER_JOURNEY_KEYWORD_INSTRUCTIONS = `
You are an expert SEO strategist specializing in buyer-journey interruption keyword research.

Your task is to take a seed search query and generate relevant keyword opportunities that go beyond synonyms.

Do not merely expand the seed query. Infer:
1. What solution the searcher assumes they need.
2. What underlying problem, pain, job-to-be-done, or trigger likely caused the search.
3. What adjacent solutions, substitutes, workarounds, DIY paths, comparison paths, and education paths the user may also consider.
4. Which keywords indicate openness to alternatives, such as "pricing," "reviews," "competitors," "alternatives," "vs," "how to," "near me," "template," "checklist," or "why."
5. Which content angles can ethically introduce the provided product or service as one possible solution.

Important guardrails:
- Do not generate misleading, manipulative, or fear-based keywords.
- For health, legal, finance, career, or safety topics, avoid cure/guarantee claims and include a responsible disclaimer in the content angle.
- The product should not be forced into every keyword. Prioritize usefulness and search intent.
- Separate high-intent commercial keywords from educational/problem-aware keywords.
- Favor clusters that could become useful articles, comparison pages, checklists, tools, templates, or landing pages.
- Output only valid JSON matching the provided schema.
`.trim();

export const BUYER_JOURNEY_KEYWORD_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    seed_query: { type: "string" },
    assumed_solution: { type: "string" },
    underlying_problem: { type: "string" },
    searcher_stage: {
      type: "string",
      enum: ["awareness", "consideration", "decision", "mixed"],
    },
    openness_signals: {
      type: "array",
      items: { type: "string" },
    },
    keyword_clusters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          cluster_name: { type: "string" },
          cluster_type: {
            type: "string",
            enum: [
              "direct_intent",
              "problem_aware",
              "alternative_solution",
              "comparison",
              "substitute",
              "diy_or_template",
              "objection_or_risk",
              "commercial_openness",
              "local_or_contextual",
              "ethical_pivot",
            ],
          },
          why_it_matters: { type: "string" },
          keywords: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                keyword: { type: "string" },
                intent: {
                  type: "string",
                  enum: [
                    "informational",
                    "commercial",
                    "transactional",
                    "navigational",
                    "local",
                  ],
                },
                priority: {
                  type: "integer",
                  minimum: 1,
                  maximum: 5,
                },
                content_angle: { type: "string" },
                soft_product_pivot: { type: "string" },
              },
              required: [
                "keyword",
                "intent",
                "priority",
                "content_angle",
                "soft_product_pivot",
              ],
            },
          },
        },
        required: ["cluster_name", "cluster_type", "why_it_matters", "keywords"],
      },
    },
    recommended_content_assets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          asset_type: {
            type: "string",
            enum: [
              "blog_post",
              "comparison_page",
              "checklist",
              "template",
              "tool",
              "landing_page",
              "faq",
              "webinar",
              "case_study",
            ],
          },
          title: { type: "string" },
          target_keywords: {
            type: "array",
            items: { type: "string" },
          },
          cta_style: {
            type: "string",
            enum: [
              "educational",
              "soft_demo",
              "free_tool",
              "download",
              "consultation",
              "trial",
            ],
          },
        },
        required: ["asset_type", "title", "target_keywords", "cta_style"],
      },
    },
    ethical_notes: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "seed_query",
    "assumed_solution",
    "underlying_problem",
    "searcher_stage",
    "openness_signals",
    "keyword_clusters",
    "recommended_content_assets",
    "ethical_notes",
  ],
} satisfies Record<string, unknown>;

function compactLine(label: string, value: string | string[] | null | undefined): string {
  const rendered = Array.isArray(value)
    ? value.filter(Boolean).join(", ")
    : (value ?? "").trim();
  return `${label}: ${rendered || "not specified"}`;
}

export function buildBuyerJourneyKeywordPrompt(input: BuyerJourneyKeywordInput): string {
  return [
    compactLine("Seed query", input.seedQuery),
    compactLine("Additional seed queries", input.additionalSeeds),
    compactLine("Product or service to promote", input.offer),
    compactLine("Target audience", input.audience),
    compactLine("Website or brand", input.brand),
    compactLine("Geography, if relevant", input.geography),
    compactLine("Industry or category", input.industry),
    compactLine("Known competitors or substitutes, if any", input.competitors),
    compactLine("Tone", input.tone || "helpful, educational, non-pushy"),
    "",
    "Generate buyer-journey interruption keyword opportunities.",
  ].join("\n");
}

function normalizeKeyword(keyword: string): string {
  return keyword
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
}

export function flattenBuyerJourneyKeywords(
  output: BuyerJourneyKeywordOutput,
  limit = 160,
): BuyerJourneyKeywordCandidate[] {
  const candidates: Array<BuyerJourneyKeywordCandidate & { order: number }> = [];
  let order = 0;

  for (const cluster of output.keyword_clusters) {
    for (const item of cluster.keywords) {
      const keyword = normalizeKeyword(item.keyword);
      if (keyword.length < 2 || keyword.length > 80) continue;
      if (/https?:\/\//i.test(keyword)) continue;
      candidates.push({
        keyword,
        intent: item.intent,
        priority: item.priority,
        clusterType: cluster.cluster_type,
        clusterName: cluster.cluster_name,
        contentAngle: item.content_angle,
        softProductPivot: item.soft_product_pivot,
        order: order++,
      });
    }
  }

  const seen = new Set<string>();
  return candidates
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.order - b.order;
    })
    .filter((candidate) => {
      if (seen.has(candidate.keyword)) return false;
      seen.add(candidate.keyword);
      return true;
    })
    .slice(0, limit)
    .map(({ order: _order, ...candidate }) => candidate);
}

export async function generateBuyerJourneyKeywordOpportunities(
  input: BuyerJourneyKeywordInput,
  deps?: {
    anthropic?: Anthropic | null;
    openai?: OpenAI | null;
    anthropicApiKey?: string;
    openaiApiKey?: string;
    backendAiProvider?: string;
  },
): Promise<{
  output: BuyerJourneyKeywordOutput;
  candidates: BuyerJourneyKeywordCandidate[];
}> {
  const anthropic =
    deps?.anthropic ??
    (deps?.anthropicApiKey || env.anthropicApiKey
      ? new Anthropic({ apiKey: deps?.anthropicApiKey ?? env.anthropicApiKey })
      : null);
  const openai =
    deps?.openai ??
    (deps?.openaiApiKey || env.openaiApiKey
      ? new OpenAI({ apiKey: deps?.openaiApiKey ?? env.openaiApiKey })
      : null);

  const generated = await generateStructuredOutput({
    name: "buyer_journey_keyword_research",
    schema: BuyerJourneyKeywordOutput,
    system: BUYER_JOURNEY_KEYWORD_INSTRUCTIONS,
    user: buildBuyerJourneyKeywordPrompt(input),
    anthropic,
    openai,
    preference: deps?.backendAiProvider,
    anthropicModel: CLAUDE_KEYWORD_MODEL,
    maxTokens: 5000,
    anthropicEffort: false,
    openaiStructuredOutputs: true,
    openaiJsonSchema: BUYER_JOURNEY_KEYWORD_JSON_SCHEMA,
  });

  return {
    output: generated.output,
    candidates: flattenBuyerJourneyKeywords(generated.output),
  };
}
