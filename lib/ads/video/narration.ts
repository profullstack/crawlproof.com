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
import {
  MAX_NARRATION_SPEEDUP,
  NARRATION_BUDGET_MS,
  NARRATION_CHARS_PER_SEC,
} from "./profiles";
import type { VideoDesignSnapshot } from "./snapshot";

/**
 * The longest line worth sending to the synthesiser.
 *
 * Derived rather than picked: the read has NARRATION_BUDGET_MS to land in, it
 * may be sped up to MAX_NARRATION_SPEEDUP to get there, and a voice covers
 * about NARRATION_CHARS_PER_SEC. That makes 59 characters, where this constant
 * used to say 140 — which is where the truncated ads came from. 140 characters
 * is nine seconds of speech offered a five-second spot, and the spot won.
 *
 * It is an estimate and it is only used to choose between candidate lines.
 * What actually guarantees the read fits is measuring the audio that comes
 * back; see fitNarrationArgs in ./encode.
 */
export const MAX_NARRATION_CHARS = Math.floor(
  (NARRATION_BUDGET_MS / 1000) * MAX_NARRATION_SPEEDUP * NARRATION_CHARS_PER_SEC,
);

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
  for (const line of narrationVariants(snapshot)) {
    if (line.length <= MAX_NARRATION_CHARS) return line;
  }

  // Every candidate is over the estimate, which takes a domain longer than the
  // budget on its own — a 62-character .onion address, for instance.
  //
  // The bare domain, then, and emphatically not a clip of the fullest line.
  // Clipping was the first thing written here and it produced "Open this
  // .onion address. Open in Tor at." — an advert that names nothing, because
  // trimming from the end removes the destination first. A brisk complete
  // address is an advert; a fluent introduction to no address is not.
  //
  // Nothing is lost by returning a line over the estimate: the estimate only
  // chooses between candidates, and the fit measures what actually comes back
  // and compresses it into the spot regardless of how long it turned out to be.
  const variants = narrationVariants(snapshot);
  return variants[variants.length - 1];
}

/**
 * The line to speak, from fullest to barest.
 *
 * Shortening a spot is a choice about what to drop, and dropping words off the
 * end — which is what a character cap does, and what the encoder was doing to
 * the finished audio — drops exactly the wrong ones: the destination is last
 * because it is what a listener is meant to leave with.
 *
 * So each step here drops a whole clause and keeps the domain. The call to
 * action goes before the headline does: "Independent podcasts, all self-hosted.
 * p0dcasters.com." is still an advert that says what it is and where to go,
 * whereas the headline is the only thing carrying the offer on an audio-only
 * break where there is no picture to read it from.
 */
export function narrationVariants(snapshot: VideoDesignSnapshot): string[] {
  const headline = snapshot.headline.trim().replace(/\s+/g, " ");
  const cta = snapshot.ctaText.trim().replace(/\s+/g, " ");
  const domain = snapshot.domain.trim();

  // A headline that already ends in punctuation should not gain a second full
  // stop; one that does not needs one, or the two clauses run together.
  const head = /[.!?]$/.test(headline) ? headline : `${headline}.`;

  return [`${head} ${cta} at ${domain}.`, `${head} ${domain}.`, `${cta} at ${domain}.`, `${domain}.`];
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
