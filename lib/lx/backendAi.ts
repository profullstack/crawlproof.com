import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { z } from "zod/v4";
import { recordAiSpend } from "@/lib/ai/spend";
import { env } from "../env";

export type BackendAiProvider = "anthropic" | "openai";
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

export function hasBackendAiTextProvider(input: {
  anthropicApiKey?: string;
  openaiApiKey?: string;
}): boolean {
  return !!input.anthropicApiKey || !!input.openaiApiKey;
}

export function backendAiTextProviderLabel(): string {
  const pref = normalizeBackendAiPreference();
  return pref === "auto" ? "Anthropic or OpenAI" : pref === "openai" ? "OpenAI" : "Anthropic";
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
  const providers = orderedBackendAiProviders({
    preference: args.preference,
    hasAnthropic: !!args.anthropic,
    hasOpenAI: !!args.openai,
  });
  if (providers.length === 0) {
    throw new Error(
      "No backend AI provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.",
    );
  }

  const errors: string[] = [];
  for (const provider of providers) {
    try {
      if (provider === "anthropic") {
        return { provider, output: await generateWithAnthropic(args) };
      }
      return { provider, output: await generateWithOpenAI(args) };
    } catch (err) {
      errors.push(
        `${provider}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new Error(`Backend AI generation failed (${errors.join("; ")})`);
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
    max_output_tokens: args.maxTokens,
    reasoning: { effort: "medium" },
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
