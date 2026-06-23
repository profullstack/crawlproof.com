import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

// Sakana Fugu — an orchestration model that routes each request across a
// swappable pool of frontier LLMs. Speaks the OpenAI-compatible Chat
// Completions API (Sakana also offers a Responses API, but oa-compat is
// chat-completions + streaming JSON, same as every other engine here).
// Base URL + model are env-overridable; defaults match Sakana's console.
export async function fuguAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.fuguApiKey,
    baseURL: env.fuguBaseUrl,
    model: env.fuguModel,
    providerLabel: "Sakana Fugu",
    maxOutputTokens: 32_000,
  });
}
