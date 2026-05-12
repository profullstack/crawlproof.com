import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function kimiAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.moonshotApiKey,
    baseURL: "https://api.moonshot.ai/v1",
    model: "kimi-k2-turbo-preview",
    providerLabel: "Kimi",
  });
}
