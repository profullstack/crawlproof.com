import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function kimiAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.moonshotApiKey,
    baseURL: "https://api.moonshot.ai/v1",
    // Confirmed via GET /v1/models on this account: kimi-k2.6 is the
    // current K2 build (256K context, supports reasoning + vision).
    // The preview / "-latest" aliases never resolved on this endpoint.
    model: "kimi-k2.6",
    providerLabel: "Kimi",
    // Moonshot caps max_tokens at 32768.
    maxOutputTokens: 32_768,
    // K2.6 only accepts temperature=1; any other value 400s with
    // "invalid temperature: only 1 is allowed for this model".
    temperature: 1,
  });
}
