import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

// Perplexity's Sonar API is OpenAI-chat-compatible. sonar-pro is the
// web-grounded flagship — citations come back in `citations` on the
// response but our schema doesn't use them yet. Page content is
// pre-fetched in oaCompatAudit and passed as context, same shape as
// every other non-Anthropic engine.
export async function perplexityAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.perplexityApiKey,
    baseURL: "https://api.perplexity.ai",
    model: "sonar-pro",
    providerLabel: "Perplexity",
    // Sonar API supports up to 8K output tokens.
    maxOutputTokens: 8_192,
  });
}
