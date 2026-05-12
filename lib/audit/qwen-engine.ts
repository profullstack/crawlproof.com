import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function qwenAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.dashscopeApiKey,
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    providerLabel: "Qwen",
  });
}
