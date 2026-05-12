import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function qwenAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.qwenApiKey,
    baseURL: env.qwenApiUrl,
    model: "qwen-max",
    providerLabel: "Qwen",
  });
}
