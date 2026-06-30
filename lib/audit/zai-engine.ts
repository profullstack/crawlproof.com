import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function zaiAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.zaiApiKey,
    // Z.AI (Zhipu) open platform — OpenAI-compatible Chat Completions.
    baseURL: "https://api.z.ai/api/paas/v4",
    // GLM-4.6 is Zhipu's current flagship; OpenAI-compatible JSON output.
    model: "glm-4.6",
    providerLabel: "Z.AI",
    // GLM-4.6 accepts large outputs; 32K comfortably fits the full JSON report.
    maxOutputTokens: 32_768,
  });
}
