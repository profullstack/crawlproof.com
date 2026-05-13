import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import { aeoAuditResponseFormat } from "./result-schema";
import type { ClaudeAuditResult } from "./claude-engine";

// Sonar rejects response_format = json_object with a 400 — needs the
// explicit json_schema variant. Shared schema lives in result-schema.ts.
export async function perplexityAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.perplexityApiKey,
    baseURL: "https://api.perplexity.ai",
    model: "sonar-pro",
    providerLabel: "Perplexity",
    maxOutputTokens: 8_192,
    responseFormat: aeoAuditResponseFormat(),
  });
}
