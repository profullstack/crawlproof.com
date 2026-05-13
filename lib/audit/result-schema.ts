import type { ChatCompletionCreateParams } from "openai/resources/chat/completions";

// Hand-mirrored JSON Schema for ResultSchema in oa-compat-engine.ts.
// Engines that need strict structured-output enforcement (Perplexity Sonar,
// Gemini via Google's OpenAI-compat layer) pass this through
// response_format = json_schema. Keep in sync with ResultSchema (zod) —
// the engine's safeParse step will catch drift loudly.
export const AEO_AUDIT_JSON_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number" },
    summary: {
      type: "object",
      properties: {
        pass: { type: "number" },
        warn: { type: "number" },
        fail: { type: "number" },
        unknown: { type: "number" },
        dataFound: {
          type: "array",
          items: {
            type: "object",
            properties: {
              dataPoint: { type: "string" },
              found: { type: "boolean" },
              source: { type: ["string", "null"] },
              notes: { type: ["string", "null"] },
            },
            required: ["dataPoint", "found", "source", "notes"],
          },
        },
      },
      required: ["pass", "warn", "fail", "unknown", "dataFound"],
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          section: { type: "string" },
          check_key: { type: "string" },
          status: { type: "string", enum: ["pass", "warn", "fail", "unknown"] },
          title: { type: "string" },
          detail: { type: "string" },
          priority: { type: "integer" },
        },
        required: ["section", "check_key", "status", "title", "priority"],
      },
    },
    markdown: { type: "string" },
  },
  required: ["score", "summary", "findings", "markdown"],
} as const;

// Shorthand for the response_format payload most strict-JSON providers
// accept (Perplexity Sonar, Gemini OpenAI-compat).
export function aeoAuditResponseFormat(): NonNullable<
  ChatCompletionCreateParams["response_format"]
> {
  return {
    type: "json_schema",
    json_schema: {
      name: "aeo_audit",
      schema: AEO_AUDIT_JSON_SCHEMA as unknown as Record<string, unknown>,
    },
  };
}
