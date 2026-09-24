// Does this encode actually satisfy the media contract?
//
// The question is asked of the decoded output, never of the job that produced
// it. A render worker reporting success proves it did not crash; it does not
// prove the file has 150 frames, that they are 30 fps, that the audio ends
// where the video does, or that the thing is under its byte budget. Those are
// facts about bytes on disk, so they are measured from bytes on disk.

import { statSync } from "node:fs";
import {
  AUDIO_TOLERANCE_MS,
  PREROLL_FPS,
  PREROLL_FRAMES,
  PREROLL_MS,
  videoProfile,
  withinBudget,
  type VideoProfileId,
} from "./profiles";
import { FFPROBE_BIN, run } from "./encode";

export type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  /** "30/1" — a rational, because 29.97 must not silently pass as 30. */
  r_frame_rate?: string;
  avg_frame_rate?: string;
  /** Present only with -count_frames; it is a decode, not a header read. */
  nb_read_frames?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
};

export type ProbeResult = {
  streams: ProbeStream[];
  format?: { duration?: string; format_name?: string; size?: string };
};

/**
 * -count_frames is the point of this invocation.
 *
 * Without it ffprobe reports `nb_frames` from the container header, which is
 * whatever the muxer wrote down — including on a file whose frames were
 * truncated. Counting means decoding every frame, which is slower and is the
 * only way the number means anything.
 */
export function probeArgs(filePath: string): string[] {
  return [
    "-v",
    "error",
    "-count_frames",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ];
}

export async function probeMedia(filePath: string): Promise<ProbeResult> {
  const out = await run(FFPROBE_BIN, probeArgs(filePath), 180_000);
  return JSON.parse(out) as ProbeResult;
}

/** "30/1" → 30. Returns null for a malformed or zero-denominator rational. */
export function parseRational(r: string | undefined): number | null {
  if (!r) return null;
  const [n, d] = r.split("/");
  const num = Number(n);
  const den = d === undefined ? 1 : Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}

export type ValidationProblem = { check: string; expected: string; actual: string };

export type ValidationResult = {
  ok: boolean;
  problems: ValidationProblem[];
  measured: {
    frames: number | null;
    fps: number | null;
    width: number | null;
    height: number | null;
    videoCodec: string | null;
    pixFmt: string | null;
    audioCodec: string | null;
    audioDurationMs: number | null;
    byteSize: number | null;
  };
};

/**
 * Evaluate a probe against a profile's requirements.
 *
 * Pure: takes the probe and the byte size, returns problems. Kept separate from
 * probeMedia so the awkward cases — 29.97 fps, a 149-frame encode, an audio
 * track two frames long — can be tested as data instead of by manufacturing a
 * broken file for each one.
 */
export function evaluateProbe(
  probe: ProbeResult,
  profileId: VideoProfileId,
  byteSize: number | null,
  opts: { expectAudio: boolean } = { expectAudio: false },
): ValidationResult {
  const problems: ValidationProblem[] = [];
  const profile = videoProfile(profileId);
  const video = probe.streams.find((s) => s.codec_type === "video");
  const audio = probe.streams.find((s) => s.codec_type === "audio");

  const frames = video?.nb_read_frames ? Number(video.nb_read_frames) : null;
  const fps = parseRational(video?.r_frame_rate);
  const audioDurationMs = audio?.duration ? Number(audio.duration) * 1000 : null;

  const measured = {
    frames,
    fps,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    pixFmt: video?.pix_fmt ?? null,
    audioCodec: audio?.codec_name ?? null,
    audioDurationMs,
    byteSize,
  };

  const fail = (check: string, expected: string, actual: unknown) =>
    problems.push({ check, expected, actual: String(actual) });

  if (!video) {
    fail("video stream", "present", "absent");
    return { ok: false, problems, measured };
  }

  // The duration requirement, stated the only way it can be checked.
  if (frames !== PREROLL_FRAMES) fail("frame count", String(PREROLL_FRAMES), frames);

  // Exactly 30, not 29.97. A 30000/1001 encode drifts ~5ms across five seconds,
  // which is small — but it means the frame at index 149 is not at 4966.67ms,
  // and the quartile boundaries measured against played media time stop lining
  // up with the frames they name.
  if (fps !== PREROLL_FPS) fail("frame rate", `${PREROLL_FPS}/1`, video.r_frame_rate ?? fps);

  if (video.codec_name !== "h264") fail("video codec", "h264", video.codec_name);
  if (video.pix_fmt !== "yuv420p") fail("pixel format", "yuv420p (8-bit)", video.pix_fmt);

  if (profile.width && video.width !== profile.width) {
    fail("width", String(profile.width), video.width);
  }
  if (profile.height && video.height !== profile.height) {
    fail("height", String(profile.height), video.height);
  }

  if (opts.expectAudio) {
    if (!audio) {
      fail("audio stream", "present", "absent");
    } else {
      if (audio.codec_name !== "aac") fail("audio codec", "aac", audio.codec_name);
      if (Number(audio.sample_rate) !== 48_000) fail("audio sample rate", "48000", audio.sample_rate);
      if (audioDurationMs !== null) {
        // One AAC frame of slack, no more. AAC cannot land on an arbitrary
        // boundary, so some rounding here is correct rather than a defect —
        // but two frames of it means the track is genuinely the wrong length.
        const drift = Math.abs(audioDurationMs - PREROLL_MS);
        if (drift > AUDIO_TOLERANCE_MS) {
          fail(
            "audio duration",
            `${PREROLL_MS}ms ±${AUDIO_TOLERANCE_MS.toFixed(3)}ms (one AAC frame)`,
            `${audioDurationMs.toFixed(3)}ms (drift ${drift.toFixed(3)}ms)`,
          );
        }
      }
    }
  } else if (audio) {
    // A silent profile that somehow carries a track is not a harmless extra:
    // it is how an ad ends up making noise over a stream nobody expected it to.
    fail("audio stream", "absent", audio.codec_name ?? "present");
  }

  if (byteSize !== null && !withinBudget(profileId, byteSize)) {
    fail("byte size", `<= ${profile.maxBytes} bytes`, `${byteSize} bytes`);
  }

  return { ok: problems.length === 0, problems, measured };
}

/** Probe a file on disk and evaluate it. */
export async function validateRendition(
  filePath: string,
  profileId: VideoProfileId,
  opts: { expectAudio: boolean } = { expectAudio: false },
): Promise<ValidationResult> {
  const probe = await probeMedia(filePath);
  let byteSize: number | null = null;
  try {
    byteSize = statSync(filePath).size;
  } catch {
    byteSize = null;
  }
  return evaluateProbe(probe, profileId, byteSize, opts);
}

/**
 * Structural checks on a generated HLS media playlist.
 *
 * Text, not media — this asks whether the packaging says what we require, which
 * is a different question from whether the segments decode. Both are checked;
 * this is the cheap half.
 */
export function validateMediaPlaylist(playlist: string): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const has = (tag: string) => playlist.includes(tag);

  if (!has("#EXTM3U")) problems.push({ check: "playlist", expected: "#EXTM3U", actual: "absent" });
  // A finite VOD package. Without ENDLIST a player treats it as a live window
  // and keeps reloading a playlist that will never change.
  if (!has("#EXT-X-ENDLIST")) {
    problems.push({ check: "playlist", expected: "#EXT-X-ENDLIST", actual: "absent" });
  }
  if (!has("#EXT-X-MAP")) {
    problems.push({ check: "playlist", expected: "#EXT-X-MAP (fMP4 init)", actual: "absent" });
  }
  if (has("#EXT-X-INDEPENDENT-SEGMENTS")) {
    problems.push({
      check: "playlist",
      expected: "no EXT-X-INDEPENDENT-SEGMENTS (we do not guarantee it)",
      actual: "present",
    });
  }

  const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
  if (durations.length === 0) {
    problems.push({ check: "segments", expected: ">= 1", actual: "0" });
  } else {
    const total = durations.reduce((a, b) => a + b, 0) * 1000;
    // Generous: segment durations are written to 6dp from a timebase, and the
    // sum of three of them accumulates rounding. Half a frame is plenty tight
    // to catch a missing or duplicated segment, which is what this is for.
    const tolerance = 1000 / PREROLL_FPS / 2;
    if (Math.abs(total - PREROLL_MS) > tolerance) {
      problems.push({
        check: "segment total duration",
        expected: `${PREROLL_MS}ms ±${tolerance.toFixed(2)}ms`,
        actual: `${total.toFixed(3)}ms`,
      });
    }
  }

  return problems;
}
