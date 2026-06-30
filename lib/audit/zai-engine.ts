import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function zaiAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.zaiApiKey,
    // Z.AI (Zhipu) — OpenAI-compatible Chat Completions. Defaults to the
    // GLM Coding Plan endpoint (the monthly subscription), which bills
    // against the plan rather than the pay-as-you-go API balance that the
    // standard /api/paas/v4 endpoint requires. Override via ZAI_BASE_URL.
    baseURL: env.zaiBaseUrl,
    // GLM-5.2 is Zhipu's current flagship; OpenAI-compatible JSON output.
    model: "glm-5.2",
    providerLabel: "Z.AI",
    // GLM-5.2 accepts large outputs; 32K comfortably fits the full JSON report.
    maxOutputTokens: 32_768,
  });
}
