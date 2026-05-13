import { env } from "../env";
import { oaCompatAudit } from "./oa-compat-engine";
import type { ClaudeAuditResult } from "./claude-engine";

// Gemini through Google's OpenAI-compatible endpoint. We lose live Google
// Search grounding (that's only available via the native @google/genai SDK),
// but in exchange we get a single uniform code path for every non-Anthropic
// provider. Page content is pre-fetched in oaCompatAudit and passed as
// context, so the model still has fresh data to analyze.
export async function geminiAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  return oaCompatAudit(targetUrl, {
    apiKey: env.geminiApiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-2.5-flash",
    providerLabel: "Gemini",
    // gemini-2.5-flash supports up to 65K output tokens.
    maxOutputTokens: 65_000,
  });
}
