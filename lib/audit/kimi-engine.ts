import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

export async function kimiAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.moonshotApiKey,
    baseURL: "https://api.moonshot.ai/v1",
    // kimi-k2.6 (dot, not hyphen) is the build that resolves with the
    // current MOONSHOT_API_KEY per Moonshot's own curl example.
    model: "kimi-k2.6",
    providerLabel: "Kimi",
    // Moonshot caps per-request output at 32768 on this build.
    maxOutputTokens: 32_768,
    // K2.6 only accepts temperature=1 (anything else 400s with
    // "invalid temperature: only 1 is allowed for this model").
    temperature: 1,
    // Match the curl example exactly: top_p tuned for reasoning, plus
    // explicit thinking mode so the model actually exercises its chain
    // of thought instead of returning a tight one-shot answer.
    extraBody: {
      top_p: 0.95,
      thinking: { type: "enabled" },
    },
  });
}
