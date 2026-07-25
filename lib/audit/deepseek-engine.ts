import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function deepseekAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.deepseekApiKey,
    baseURL: "https://api.deepseek.com",
    // V4 flash — cheapest of the live engines, OpenAI-compatible.
    // See env.deepseekModel for why the old `deepseek-chat` alias is gone.
    model: env.deepseekModel,
    providerLabel: "DeepSeek",
    // The 8K cap was a deepseek-chat limit. V4 accepts 64K, and both V4
    // tiers are reasoning models whose reasoning_content draws from the
    // same budget — the old 8K ceiling would truncate the JSON report.
    maxOutputTokens: 65_536,
  });
}
