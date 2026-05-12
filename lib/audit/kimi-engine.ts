import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function kimiAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.kimiApiKey,
    baseURL: env.kimiApiUrl,
    // 128k context — fits our pre-fetched homepage + linked pages.
    model: "moonshot-v1-128k",
    providerLabel: "Kimi",
  });
}
