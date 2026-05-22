import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function kimiAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.moonshotApiKey,
    // International endpoint. Pair with an api.moonshot.ai-issued key.
    baseURL: "https://api.moonshot.ai/v1",
    // kimi-k2-0905-preview — current K2 preview build per Moonshot's
    // own curl example. The earlier kimi-k2.6 / kimi-k2-6 ids weren't
    // resolving on this endpoint.
    model: "kimi-k2-0905-preview",
    providerLabel: "Kimi",
    // 8192 matches Moonshot's documented per-request limit for this
    // preview build. Reports may truncate vs Claude/GPT — bump if/when
    // the preview is replaced by a longer-output GA model.
    maxOutputTokens: 8192,
    // 0.3 matches Moonshot's example call for this preview build.
    // The temperature=1 lock was specific to the kimi-k2.6 build that
    // we're no longer hitting.
    temperature: 0.3,
  });
}
