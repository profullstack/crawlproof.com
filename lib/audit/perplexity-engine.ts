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
    model: "sonar-reasoning-pro",
    providerLabel: "Perplexity",
    maxOutputTokens: 32_000,
    responseFormat: aeoAuditResponseFormat(),
    // Sonar runs its web retrieval *before* it emits response headers, and
    // json_schema adds a schema-preparation pass on top. On a full audit
    // prompt that regularly blew past the shared 90s header timeout, so the
    // engine failed with a bare "Request timed out." every run. Give it 5
    // minutes of head start and drop to one retry so the worst case
    // (2 × 5min) still lands inside this engine's stuck window — see
    // PERPLEXITY_AUDIT_STUCK_AFTER_MS in timeouts.ts.
    timeoutMs: 5 * 60 * 1000,
    maxRetries: 1,
    // Once tokens start flowing Sonar is steady; a 2-minute gap means the
    // connection died, not that it's still thinking.
    idleTimeoutMs: 2 * 60 * 1000,
  });
}
