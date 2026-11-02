import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import {
  AiRouter,
  C0mputeProvider,
  generateObjectOn,
} from "@profullstack/ai-providers";
import { z } from "zod/v4";
import { recordAiSpend } from "@/lib/ai/spend";
import { env } from "../env";

export type BackendAiProvider = "c0mpute" | "anthropic" | "openai";
type BackendAiPreference = BackendAiProvider | "auto";

type StructuredOutputArgs<T> = {
  name: string;
  schema: z.ZodType<T>;
  system: string;
  user: string;
  maxTokens: number;
  anthropicModel: string;
  openaiModel?: string;
  anthropic?: Anthropic | null;
  openai?: OpenAI | null;
  preference?: string;
  anthropicCacheSystemPrompt?: boolean;
  anthropicEffort?: "low" | "medium" | "high" | false;
  openaiStructuredOutputs?: boolean;
  openaiJsonSchema?: Record<string, unknown>;
};

export function normalizeBackendAiPreference(
  raw = env.backendAiProvider,
): BackendAiPreference {
  const v = raw.trim().toLowerCase();
  if (v === "anthropic" || v === "claude") return "anthropic";
  if (v === "openai") return "openai";
  return "auto";
}

export function orderedBackendAiProviders(input: {
  preference?: string;
  hasAnthropic: boolean;
  hasOpenAI: boolean;
}): BackendAiProvider[] {
  const pref = normalizeBackendAiPreference(input.preference);
  const available: BackendAiProvider[] = [];
  if (input.hasAnthropic) available.push("anthropic");
  if (input.hasOpenAI) available.push("openai");
  if (available.length === 0) return [];
  if (pref === "auto") return available;
  return [
    ...(available.includes(pref) ? [pref] : []),
    ...available.filter((p) => p !== pref),
  ];
}

/**
 * c0mpute is the default for every text call: the peer network through
 * Infernet, no paid key needed. OpenAI and Anthropic are fallbacks only,
 * alternating call by call so neither bill takes all the overflow, and a key
 * that answers "no credits" is parked for an hour instead of retried.
 * C0MPUTE_DISABLED=1 turns c0mpute off.
 */
export function c0mputeEnabled(): boolean {
  return !/^(1|true|yes|on)$/i.test(process.env.C0MPUTE_DISABLED ?? "");
}

let router: AiRouter | null = null;
function backendRouter(): AiRouter {
  if (router) return router;
  const models = (process.env.C0MPUTE_MODELS ?? process.env.C0MPUTE_MODEL ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const num = (v?: string) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  // The paid tier is crawlproof's own SDK code (structured outputs, prompt
  // caching, spend rows); the router only needs their names to order them.
  const named = (name: string) =>
    ({ name, generate: () => Promise.reject(new Error("not used")) }) as never;
  router = new AiRouter({
    primary: c0mputeEnabled()
      ? [
          new C0mputeProvider({
            apiKey: process.env.C0MPUTE_API_KEY,
            baseUrl: process.env.C0MPUTE_URL,
            ...(models.length ? { models } : {}),
            concurrency: num(process.env.C0MPUTE_CONCURRENCY),
            stallMs: num(process.env.C0MPUTE_STALL_MS),
            // Articles run to thousands of tokens on CPU nodes.
            timeoutMs: num(process.env.C0MPUTE_TIMEOUT_MS) ?? 900_000,
          }),
        ]
      : [],
    fallback: [named("openai"), named("anthropic")],
  });
  return router;
}

export function backendAiStatus() {
  return backendRouter().status();
}

export function hasBackendAiTextProvider(input: {
  anthropicApiKey?: string;
  openaiApiKey?: string;
}): boolean {
  return c0mputeEnabled() || !!input.anthropicApiKey || !!input.openaiApiKey;
}

export function backendAiTextProviderLabel(): string {
  return c0mputeEnabled() ? "c0mpute" : "Anthropic or OpenAI";
}

/**
 * Thinking config for an Anthropic model.
 *
 * Claude 4.6 and later (Opus 5, Opus 4.8, Sonnet 5, Fable 5.1) run adaptive
 * thinking: the model decides per request how much to reason, and `effort`
 * bounds it. Sending `disabled` there is the wrong default — on Opus 5 it
 * makes the model occasionally write its reasoning into the visible answer,
 * and Fable 5.1 rejects it with a 400. Haiku 4.5 predates adaptive thinking
 * (it only knows the budget_tokens form), so it stays off there; the Haiku
 * callsites are short extraction prompts that pass `anthropicEffort: false`.
 */
export function anthropicThinkingFor(
  model: string,
): { type: "adaptive" } | { type: "disabled" } {
  return /haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|claude-3/i.test(model)
    ? { type: "disabled" }
    : { type: "adaptive" };
}

export async function generateStructuredOutput<T>(
  args: StructuredOutputArgs<T>,
): Promise<{ provider: BackendAiProvider; output: T }> {
  const only: string[] = [];
  if (c0mputeEnabled()) only.push("c0mpute");
  if (args.openai) only.push("openai");
  if (args.anthropic) only.push("anthropic");
  if (only.length === 0) {
    throw new Error(
      "No backend AI provider configured. c0mpute is disabled (C0MPUTE_DISABLED) and neither OPENAI_API_KEY nor ANTHROPIC_API_KEY is set.",
    );
  }

  try {
    const { provider, value } = await backendRouter().run(
      (p: { name: string }) => {
        if (p.name === "anthropic") return generateWithAnthropic(args);
        if (p.name === "openai") return generateWithOpenAI(args);
        return generateWithC0mpute(args, p as C0mputeProvider);
      },
      { feature: args.name, only },
    );
    return { provider: provider as BackendAiProvider, output: value };
  } catch (err) {
    // Same prefix as before, so log searches and alerts keep matching.
    throw new Error(
      `Backend AI generation failed (${
        err instanceof Error ? err.message.replace(/^AI generation failed \(|\)$/g, "") : String(err)
      })`,
    );
  }
}

async function generateWithC0mpute<T>(
  args: StructuredOutputArgs<T>,
  provider: C0mputeProvider,
): Promise<T> {
  const jsonSchema =
    args.openaiJsonSchema ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (z.toJSONSchema(args.schema as any) as Record<string, unknown>);
  const out = await generateObjectOn<T>(provider, {
    name: args.name,
    schema: args.schema,
    jsonSchema,
    system: args.system,
    user: args.user,
    maxTokens: args.maxTokens,
    temperature: 0.4,
  });
  void recordAiSpend({
    provider: "c0mpute",
    model: `c0mpute/${out.model}`,
    feature: args.name,
    inputTokens: out.usage.inputTokens,
    outputTokens: out.usage.outputTokens,
  });
  return out.object;
}

async function generateWithAnthropic<T>(
  args: StructuredOutputArgs<T>,
): Promise<T> {
  if (!args.anthropic) throw new Error("ANTHROPIC_API_KEY not set");
  const stream = args.anthropic.messages.stream({
    model: args.anthropicModel,
    max_tokens: args.maxTokens,
    thinking: anthropicThinkingFor(args.anthropicModel),
    output_config: {
      ...(args.anthropicEffort === false
        ? {}
        : { effort: args.anthropicEffort ?? "medium" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      format: zodOutputFormat(args.schema as any),
    },
    system: [
      args.anthropicCacheSystemPrompt
        ? {
            type: "text",
            text: args.system,
            cache_control: { type: "ephemeral" },
          }
        : { type: "text", text: args.system },
    ],
    messages: [{ role: "user", content: args.user }],
  });
  const response = await stream.finalMessage();
  // Recorded before the parse check: the tokens were spent whether or not the
  // output turns out to be usable, and a failed parse is exactly the kind of
  // waste worth seeing in the total.
  void recordAiSpend({
    provider: "anthropic",
    model: response.model ?? args.anthropicModel,
    feature: args.name,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
  });
  const parsed = response.parsed_output as T | null;
  if (!parsed) {
    throw new Error(
      `no parsed_output (stop_reason=${response.stop_reason ?? "unknown"})`,
    );
  }
  return parsed;
}

const OPENAI_REASONING_HEADROOM = 2048;

async function generateWithOpenAI<T>(
  args: StructuredOutputArgs<T>,
): Promise<T> {
  if (!args.openai) throw new Error("OPENAI_API_KEY not set");
  const format = args.openaiStructuredOutputs
    ? {
        type: "json_schema" as const,
        name: args.name,
        strict: true,
        schema: args.openaiJsonSchema ?? z.toJSONSchema(args.schema),
      }
    : { type: "json_object" as const };
  const response = await args.openai.responses.create({
    model: args.openaiModel ?? env.backendAiOpenaiModel,
    instructions: [
      args.system,
      "",
      `Return only a JSON object matching this ${args.name} JSON schema. Do not wrap it in Markdown.`,
      JSON.stringify(z.toJSONSchema(args.schema), null, 2),
    ].join("\n"),
    input: [
      args.user,
      "",
      "Return JSON only. The final answer must be valid JSON and must not include Markdown.",
    ].join("\n"),
    // max_output_tokens counts reasoning as well as the answer, so without
    // headroom a reasoning model spends the whole budget thinking and returns
    // nothing, billed. The outreach drafts (900 tokens, medium effort) came
    // back empty on most calls this way. A caller that turned thinking off for
    // Anthropic wants the cheap path here too.
    max_output_tokens: args.maxTokens + OPENAI_REASONING_HEADROOM,
    reasoning: { effort: args.anthropicEffort === false ? "low" : (args.anthropicEffort ?? "medium") },
    text: { format },
    store: false,
  });
  // Same reasoning as the Anthropic path: record before any check that can
  // throw, because the tokens are already spent by this point.
  void recordAiSpend({
    provider: "openai",
    model: response.model ?? args.openaiModel ?? env.backendAiOpenaiModel,
    feature: args.name,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheReadTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
  });
  if (response.error) {
    throw new Error(response.error.message);
  }
  if (!response.output_text) {
    throw new Error(
      `empty output (status=${response.status ?? "unknown"}, incomplete=${response.incomplete_details?.reason ?? "none"})`,
    );
  }
  const parsedJson = JSON.parse(response.output_text) as unknown;
  return args.schema.parse(parsedJson);
}
