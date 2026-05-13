import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

// Hand-mirrored JSON Schema for the ResultSchema in oa-compat-engine.ts.
// Sonar requires response_format = json_schema with the schema inlined;
// it rejects json_object with a 400. Keep in sync with ResultSchema.
const RESULT_JSON_SCHEMA = {
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

export async function perplexityAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.perplexityApiKey,
    baseURL: "https://api.perplexity.ai",
    model: "sonar-pro",
    providerLabel: "Perplexity",
    maxOutputTokens: 8_192,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "aeo_audit",
        schema: RESULT_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });
}
