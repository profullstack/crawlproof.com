// ad-generator-agent: the c0mpute plugin that makes every ad type on
// /dashboard/ads/new (c0mpute plugins/ad-generator-agent, DIP 0029).
//
// On by default. While it is on, each generated asset comes from c0mpute or
// from no AI at all, never from a paid API the operator did not opt into:
//
//   copy (every format, summaries)  Infernet inference on c0mpute, through
//                                   lib/lx/backendAi (the fleet-wide router;
//                                   its OpenAI/Anthropic fallback is the
//                                   standing 2026-11-02 rule, not ours to add)
//   narration (video + audio ads)   c0mpute tts.synthesize via the speech
//                                   gateway (`c0mpute speech serve`)
//   hero image (image ads)          the advertiser's og:image; c0mpute has no
//                                   live diffusion workers yet, so otherwise
//                                   none. gpt-image only with
//                                   AD_GENERATOR_PAID_IMAGES=1
//   static / gif / video / audio    rendered by our own worker (Chromium
//   assembly                        frames + ffmpeg), no model involved
//
// AD_GENERATOR_AGENT=off (or 0/false/no) restores the previous providers
// (gpt-image heroes, ElevenLabs narration).

export const AD_GENERATOR_AGENT = "ad-generator-agent";

type Env = Record<string, string | undefined>;

// Read through a variable so nothing here can be inlined at build time.
function runtimeEnv(): Env {
  const e: Env = process.env;
  return e;
}

const OFF = /^(0|off|false|no|disabled?)$/i;
const ON = /^(1|on|true|yes|enabled?)$/i;

export function adGeneratorAgentEnabled(env: Env = runtimeEnv()): boolean {
  return !OFF.test((env.AD_GENERATOR_AGENT ?? "").trim());
}

/** gpt-image heroes: always when the agent is off, only by opt-in when it is on. */
export function paidHeroImagesAllowed(env: Env = runtimeEnv()): boolean {
  if (!adGeneratorAgentEnabled(env)) return true;
  return ON.test((env.AD_GENERATOR_PAID_IMAGES ?? "").trim());
}

export type NarrationRoute = "c0mpute" | "elevenlabs";

export function narrationRoute(env: Env = runtimeEnv()): NarrationRoute {
  return adGeneratorAgentEnabled(env) ? "c0mpute" : "elevenlabs";
}

export type C0mputeSpeechTarget = {
  /** Full URL of the synthesis endpoint. */
  url: string;
  /** Bearer for a private gateway; the public Infernet route needs none. */
  token: string | null;
};

const DEFAULT_INFERNET_URL = "https://infernetprotocol.com";

/**
 * Where narration is synthesised.
 *
 * A private `c0mpute speech serve` gateway (C0MPUTE_SPEECH_URL + _TOKEN) when
 * one is configured: it has no rate limit and is the buyer this agent is meant
 * to run on. Otherwise Infernet's public voice route, which forwards to the
 * same kind of gateway, so a fresh deployment still narrates on c0mpute.
 */
export function c0mputeSpeechTarget(env: Env = runtimeEnv()): C0mputeSpeechTarget {
  const gateway = (env.C0MPUTE_SPEECH_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.C0MPUTE_SPEECH_TOKEN ?? "").trim();
  if (gateway && token) return { url: `${gateway}/v1/tts`, token };
  const base = (env.C0MPUTE_URL ?? DEFAULT_INFERNET_URL).trim().replace(/\/+$/, "");
  return { url: `${base}/api/chat/voice/tts`, token: null };
}

export function c0mputeTtsVoice(env: Env = runtimeEnv()): { engine: string; voice: string } {
  return {
    engine: (env.AD_GENERATOR_TTS_ENGINE ?? "").trim() || "kokoro",
    // Sarah, the same voice the ElevenLabs default used.
    voice: (env.AD_GENERATOR_TTS_VOICE ?? "").trim() || "af_sarah",
  };
}

/**
 * The provider label shown on the form and stored with a generation, so it is
 * visible which agent made the ad: `ad-generator-agent/c0mpute`.
 */
export function agentProviderLabel(provider: string, env: Env = runtimeEnv()): string {
  return adGeneratorAgentEnabled(env) ? `${AD_GENERATOR_AGENT}/${provider}` : provider;
}
