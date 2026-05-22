import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function kimiAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.moonshotApiKey,
    // Moonshot canonical endpoint is api.moonshot.cn/v1 — the .ai mirror
    // we were using hung on long contexts (149K-char homepage scans sat
    // for 10+ min with no response).
    baseURL: "https://api.moonshot.cn/v1",
    // Model id uses hyphen, not dot. Was "kimi-k2.6"; correct id from
    // the public docs + curl examples is "kimi-k2-6".
    model: "kimi-k2-6",
    providerLabel: "Kimi",
    // Moonshot caps max_tokens at 32768.
    maxOutputTokens: 32_768,
    // K2 only accepts temperature=1; any other value 400s with
    // "invalid temperature: only 1 is allowed for this model".
    temperature: 1,
  });
}
