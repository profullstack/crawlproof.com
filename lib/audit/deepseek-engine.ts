import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function deepseekAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.deepseekApiKey,
    baseURL: "https://api.deepseek.com",
    // V3 chat model — cheapest of the live engines, OpenAI-compatible.
    model: "deepseek-chat",
    providerLabel: "DeepSeek",
    // deepseek-chat caps max output at 8K (default 4K).
    maxOutputTokens: 8_192,
  });
}
