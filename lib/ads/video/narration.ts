// Spoken narration for a pre-roll.
//
// The script is derived from the copy the advertiser already approved, never
// generated afresh: an ad whose voiceover claims something its banner does not
// is a compliance problem, not a stylistic one. Headline, then the call to
// action with the destination, which is the whole of what five seconds can say.
//
// Synthesis is deliberately best-effort. A pre-roll with no audio is a working
// ad; a render that fails because a speech API was rate-limited is not. Every
// failure path here returns null and the caller ships the silent cut.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoDesignSnapshot } from "./snapshot";

/** Roughly what a five-second read fits, at an unhurried pace. */
export const MAX_NARRATION_CHARS = 140;

const API = "https://api.elevenlabs.io/v1/text-to-speech";

/**
 * A default voice id.
 *
 * Overridable per deployment, because the right voice is a brand decision and
 * not something this module should hold an opinion about.
 */
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";

/**
 * The line to speak.
 *
 * Kept to one sentence plus a call to action. The headline is spoken as written
 * — it is the approved claim — and the domain is spoken last so the thing a
 * listener is meant to remember is the last thing they hear.
 */
export function narrationScript(snapshot: VideoDesignSnapshot): string {
  const headline = snapshot.headline.trim().replace(/\s+/g, " ");
  const cta = snapshot.ctaText.trim().replace(/\s+/g, " ");
  const domain = snapshot.domain.trim();

  // A headline that already ends in punctuation should not gain a second full
  // stop; one that does not needs one, or the two clauses run together.
  const head = /[.!?]$/.test(headline) ? headline : `${headline}.`;
  const line = `${head} ${cta} at ${domain}.`;

  // Truncated on a word boundary rather than mid-word: a voice cut off in the
  // middle of a word is worse than a shorter line.
  if (line.length <= MAX_NARRATION_CHARS) return line;
  const clipped = line.slice(0, MAX_NARRATION_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > 0 ? lastSpace : clipped.length).trim()}.`;
}

export type NarrationResult = {
  filePath: string;
  script: string;
  byteSize: number;
};

/**
 * Synthesise the narration, or return null.
 *
 * Null covers every failure: no API key configured, a non-200 response, an
 * empty body, a network error. The caller renders silent. This is the same rule
 * the rest of the pipeline follows — a render is an extra output of saving a
 * campaign, and the audio is an extra output of the render.
 */
export async function synthesiseNarration(input: {
  snapshot: VideoDesignSnapshot;
  workDir: string;
  apiKey?: string | null;
  voiceId?: string;
  fetchImpl?: typeof fetch;
}): Promise<NarrationResult | null> {
  // `undefined` means "use the configured key"; an explicit null means "there
  // is no key", which is what a caller says when it wants the silent cut. `??`
  // collapsed those two into one and made an explicit null fall through to the
  // environment — so asking for silence quietly performed a paid API call.
  const apiKey =
    input.apiKey === undefined ? (process.env.ELEVENLABS_API_KEY ?? null) : input.apiKey;
  if (!apiKey) return null;

  const script = narrationScript(input.snapshot);
  if (!script.trim()) return null;

  const doFetch = input.fetchImpl ?? fetch;
  const voice = input.voiceId ?? DEFAULT_VOICE;

  try {
    const res = await doFetch(`${API}/${voice}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: script,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    // A 200 with no body is a failure wearing a success code, and muxing zero
    // bytes produces a file ffmpeg will reject much later with a worse message.
    if (buf.byteLength === 0) return null;

    const filePath = path.join(input.workDir, "narration.mp3");
    await writeFile(filePath, buf);
    return { filePath, script, byteSize: buf.byteLength };
  } catch {
    return null;
  }
}
