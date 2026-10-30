/** Advertiser-safe explanations; never show raw provider responses. */
export function renderFailureMessage(code: string | null): string {
  if (code === "narration_payment_required" || code === "narration_voice_unavailable" || code === "narration_access_denied" || code === "narration_not_configured" || code === "missing_narration_audio") {
    return "The voiceover service could not provide this campaign’s narration. Our team needs to correct the voice configuration before retrying. Your campaign copy is saved; editing it will not fix this service issue.";
  }
  if (code?.startsWith("narration_")) return "The voiceover service was unavailable after retrying. Your campaign copy is saved. Please contact support to retry the pre-roll.";
  return "Rendering failed. Please contact support to retry this pre-roll; your campaign copy is saved.";
}
