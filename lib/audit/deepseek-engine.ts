import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function deepseekAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.deepseekApiKey,
    baseURL: env.deepseekApiUrl,
    // V3 chat model — cheapest of the live engines, OpenAI-compatible.
    model: "deepseek-chat",
    providerLabel: "DeepSeek",
  });
}
