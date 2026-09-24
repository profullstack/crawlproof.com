// ffmpeg invocations for the five-second pre-roll.
//
// Argument construction is separated from execution on purpose: the arguments
// are where the media contract actually lives (GOP length is what makes the
// HLS segment boundaries land on 0/2/4s; +faststart is what makes the MP4
// playable before it has finished downloading), and a pure builder is something
// a test can assert without a 90-second encode.

import { spawn } from "node:child_process";
import path from "node:path";
import {
  AAC_SAMPLE_RATE,
  HLS_KEYFRAME_SECONDS,
  PREROLL_FPS,
  PREROLL_FRAMES,
  videoProfile,
  PREROLL_MS,
  type VideoProfileId,
} from "./profiles";

export const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE_BIN = process.env.FFPROBE_PATH || "ffprobe";

/**
 * Frames between keyframes.
 *
 * HLS_KEYFRAME_SECONDS is [0, 2, 4] and the ad runs at 30 fps, so a keyframe
 * every 60 frames puts one exactly at each boundary. `-sc_threshold 0` stops
 * x264 inserting extra keyframes on scene changes, which would be harmless for
 * playback but would make segment durations depend on the artwork.
 */
export const GOP_FRAMES = Math.round(
  (HLS_KEYFRAME_SECONDS[1] - HLS_KEYFRAME_SECONDS[0]) * PREROLL_FPS,
);

/**
 * How far the bed sits under the voice.
 *
 * Broadcast practice is roughly 15-20 dB down: enough to be felt and not enough
 * to compete with the read. Given as dB rather than a linear figure because
 * that is the unit the decision is actually made in.
 */
const MUSIC_BED_GAIN = "-16dB";

export type Mp4EncodeOptions = {
  /** printf-style pattern of the PNG frame sequence, e.g. `/tmp/x/f-%04d.png`. */
  framePattern: string;
  /** Optional narration track. AAC-LC at 48 kHz is produced regardless of input. */
  audioPath: string | null;
  /**
   * Optional music bed, laid under the narration.
   *
   * Looped and trimmed to the spot, held well below the voice, and faded at
   * both ends. A bed that starts and stops abruptly is worse than no bed: on a
   * five-second spot the cut is most of what you hear.
   */
  musicPath?: string | null;
  outPath: string;
  profile: VideoProfileId;
  /** Video bitrate in kbps. The caller lowers it and retries if over budget. */
  videoKbps: number;
};

/**
 * Frames in, one MP4 out.
 *
 * `-frames:v 150` rather than `-t 5` for a silent encode: the contract is a
 * frame count, and a duration flag lets a timebase rounding error produce 149
 * or 151 frames that still measure "5.0 seconds". Counting frames is the check
 * that actually catches a dropped one.
 *
 * With an audio track that flag has to go. `-frames:v` ends the whole output
 * the moment the video stream hits its limit, which cuts the audio wherever the
 * encoder happened to have flushed to — around 3.3 of 5 seconds here. That is
 * not a padding problem and no amount of `apad`, `apad=whole_dur`, `atrim` or
 * `-shortest` fixes it: an input already padded to exactly 5.000s still came
 * out at 3.264s. Bounding the output by duration instead produces both a
 * 5.000s audio track and exactly 150 video frames, because 150 frames at 30fps
 * IS five seconds — the frame count is still guaranteed, just by arithmetic
 * rather than by a flag, and validation counts the frames either way.
 */
export function mp4Args(o: Mp4EncodeOptions): string[] {
  const p = videoProfile(o.profile);
  const args = [
    "-y",
    "-nostdin",
    "-framerate",
    String(PREROLL_FPS),
    "-i",
    o.framePattern,
  ];

  if (o.audioPath) args.push("-i", o.audioPath);
  // The bed is only ever an input alongside a voice; music on its own would be
  // an advert that says nothing.
  const withMusic = Boolean(o.audioPath && o.musicPath);
  if (withMusic) args.push("-stream_loop", "-1", "-i", o.musicPath!);

  // See the note above: -frames:v truncates the audio, so an encode that
  // carries sound is bounded by duration instead.
  const carriesAudio = Boolean(o.musicPath) || Boolean(o.audioPath);
  if (carriesAudio) {
    args.push("-t", String(PREROLL_MS / 1000));
  } else {
    args.push("-frames:v", String(PREROLL_FRAMES));
  }

  args.push(
    "-r",
    String(PREROLL_FPS),
    "-c:v",
    "libx264",
    // High profile, 8-bit 4:2:0. The spec's compatibility floor, and what every
    // browser and receiver in the inventory can decode in hardware.
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    `${o.videoKbps}k`,
    "-maxrate",
    `${Math.round(o.videoKbps * 1.3)}k`,
    "-bufsize",
    `${o.videoKbps * 2}k`,
    "-g",
    String(GOP_FRAMES),
    "-keyint_min",
    String(GOP_FRAMES),
    "-sc_threshold",
    "0",
  );

  if (p.width && p.height) {
    // Explicit scale rather than relying on the source size, so a compositor
    // viewport change cannot silently ship a differently-sized rendition.
    args.push("-vf", `scale=${p.width}:${p.height}:flags=lanczos`);
  }

  if (withMusic) {
    // Voice at full, bed at -16 dB under it, both exactly as long as the
    // picture. `normalize=0` on the mix, or amix halves everything to avoid a
    // clip that two sources at these levels cannot produce anyway.
    const seconds = PREROLL_FRAMES / PREROLL_FPS;
    const fade = 0.4;
    args.push(
      "-filter_complex",
      [
        `[1:a]apad,atrim=0:${seconds},asetpts=N/SR/TB[voice]`,
        `[2:a]atrim=0:${seconds},asetpts=N/SR/TB,volume=${MUSIC_BED_GAIN},` +
          `afade=t=in:st=0:d=${fade},afade=t=out:st=${(seconds - fade).toFixed(2)}:d=${fade}[bed]`,
        `[voice][bed]amix=inputs=2:duration=first:normalize=0[a]`,
      ].join(";"),
      "-map", "0:v",
      "-map", "[a]",
    );
    args.push("-c:a", "aac", "-profile:a", "aac_low", "-ar", String(AAC_SAMPLE_RATE), "-b:a", "128k", "-ac", "2");
  } else if (o.audioPath) {
    // `apad` extends the audio with silence indefinitely, and `-shortest` then
    // trims the result to the video's five seconds — so the track is exactly as
    // long as the picture.
    //
    // Without the pad, a narration shorter than the ad (which every narration
    // is: a five-second read is about two and a half seconds of speech) left an
    // audio stream that ended early. Validation requires the two durations to
    // match within one AAC frame and rejected every narrated render, and a
    // player handed a short track is entitled to stop at its end.
    // apad extends the audio with silence; -t then fixes the output at exactly
    // the ad's length so picture and sound agree to the millisecond.
    //
    // -shortest was the obvious pairing and does not work here: in ffmpeg 4.x
    // it keys off INPUT durations, so an infinitely padded filter output does
    // not extend it and the encode either kept the original 2.3s of speech or,
    // once padded, dropped the stream entirely. An explicit duration is not a
    // workaround — it is the thing actually being asserted.
    args.push("-af", "apad");
    args.push("-c:a", "aac", "-profile:a", "aac_low", "-ar", String(AAC_SAMPLE_RATE), "-b:a", "128k", "-ac", "2");
  } else {
    args.push("-an");
  }

  // Move the moov atom to the front. Without it a player must fetch the tail of
  // the file before it can start, which on a five-second pre-roll is most of
  // the budget spent before the first frame.
  args.push("-movflags", "+faststart", o.outPath);
  return args;
}

export type HlsOptions = {
  /** Source MP4 for this rendition — already encoded with aligned keyframes. */
  inPath: string;
  outDir: string;
  /** Basename, e.g. "720p": yields 720p.m3u8, 720p-init.mp4, 720p-1.m4s… */
  name: string;
};

/**
 * Package one rendition as fMP4 HLS.
 *
 * `-c copy` is load-bearing. Re-encoding here would move the keyframes and
 * break the 0/2/4s boundaries the MP4 was encoded to hit, and it would also
 * mean the HLS a viewer streams is not the same media the advertiser
 * downloaded and approved.
 */
export function hlsArgs(o: HlsOptions): string[] {
  return [
    "-y",
    "-nostdin",
    "-i",
    o.inPath,
    "-c",
    "copy",
    "-f",
    "hls",
    "-hls_time",
    String(HLS_KEYFRAME_SECONDS[1] - HLS_KEYFRAME_SECONDS[0]),
    "-hls_playlist_type",
    "vod", // writes EXT-X-ENDLIST; this is a finite VOD package, not a live window
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    `${o.name}-init.mp4`,
    "-hls_list_size",
    "0",
    "-hls_segment_filename",
    path.join(o.outDir, `${o.name}-%d.m4s`),
    path.join(o.outDir, `${o.name}.m3u8`),
  ];
}

/**
 * RFC 6381 codec string for an H.264 stream: avc1.PPCCLL.
 *
 * PP is profile_idc, CC the constraint flags, LL the level, each as two hex
 * digits. ffprobe reports the profile by name and the level as an integer, so
 * the name is mapped back to its idc.
 *
 * This is derived from the encoded file rather than hardcoded because the
 * declaration is load-bearing: a player reads CODECS to choose a decoder
 * configuration before it fetches a segment, and a wrong level is a promise
 * about the bitstream that the bitstream does not keep.
 */
const PROFILE_IDC: Record<string, number> = {
  "Constrained Baseline": 66,
  Baseline: 66,
  Main: 77,
  Extended: 88,
  High: 100,
  "High 10": 110,
  "High 4:2:2": 122,
  "High 4:4:4 Predictive": 244,
};

export function avcCodecString(profile: string | undefined, level: number | undefined): string {
  const idc = PROFILE_IDC[profile ?? ""] ?? 100;
  const lvl = typeof level === "number" && level > 0 ? level : 31;
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  // Constraint flags are 0 for the profiles we produce; libx264 sets none that
  // belong in this field for High.
  return `avc1.${hex(idc)}00${hex(lvl)}`;
}

/** AAC-LC, appended only when a rendition actually carries an audio track. */
export const AAC_LC_CODEC = "mp4a.40.2";

/**
 * The multivariant playlist.
 *
 * Written by hand rather than by ffmpeg's var_stream_map because the bandwidth
 * and codec declarations have to describe the renditions we actually produced
 * — including not advertising an audio codec for a silent ad, which is a
 * promise a player will wait on,
 * and because EXT-X-INDEPENDENT-SEGMENTS is deliberately absent: our segments
 * open on a keyframe but are not independently decodable in the sense that tag
 * asserts, and claiming it would be a lie a player acts on.
 */
export function multivariantPlaylist(
  renditions: { name: string; width: number; height: number; bandwidth: number; codecs: string }[],
): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
  for (const r of renditions) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.width}x${r.height},CODECS="${r.codecs}"`,
    );
    lines.push(`${r.name}.m3u8`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Poster frame.
 *
 * Taken from the hold, not from frame 0: the first frame is mid-entrance, and a
 * poster is the still a viewer stares at while the player buffers. 2 seconds in
 * the composition is settled and the headline is fully up.
 */
export function posterArgs(inPath: string, outPath: string): string[] {
  return [
    "-y",
    "-nostdin",
    "-ss",
    "2",
    "-i",
    inPath,
    "-frames:v",
    "1",
    "-c:v",
    "libwebp",
    "-quality",
    "82",
    "-vf",
    "scale=1280:720:flags=lanczos",
    outPath,
  ];
}

/**
 * The audible companion, as AAC in an MP4 container.
 *
 * Produced from the same narration as the video's own track so the two cannot
 * drift into describing different offers. A silent creative has no companion:
 * five seconds of silence would be recorded as an audio ad having played, and
 * the spec is explicit that silence never satisfies an audio slot.
 */
export function audioCompanionArgs(inPath: string, outPath: string): string[] {
  return [
    "-y",
    "-nostdin",
    "-i",
    inPath,
    "-vn",
    "-c:a",
    "aac",
    "-profile:a",
    "aac_low",
    "-ar",
    String(AAC_SAMPLE_RATE),
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    outPath,
  ];
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

/**
 * Run a binary and collect stderr.
 *
 * stderr is captured rather than inherited because ffmpeg's failure message is
 * the only useful diagnostic when a render fails on a worker nobody is watching,
 * and it has to reach the job row. Only the tail is kept: a progress-spammed
 * stderr can run to megabytes and none of the early lines say why it failed.
 */
export function run(bin: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new FfmpegError(`${bin} timed out after ${timeoutMs}ms`, null, stderr.slice(-4000)));
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new FfmpegError(`${bin} failed to start: ${e.message}`, null, stderr.slice(-4000)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new FfmpegError(`${bin} exited ${code}`, code, stderr.slice(-4000)));
    });
  });
}

export const encodeMp4 = (o: Mp4EncodeOptions) => run(FFMPEG_BIN, mp4Args(o));
export const packageHls = (o: HlsOptions) => run(FFMPEG_BIN, hlsArgs(o));
export const extractPoster = (inPath: string, outPath: string) =>
  run(FFMPEG_BIN, posterArgs(inPath, outPath));
export const encodeAudioCompanion = (inPath: string, outPath: string) =>
  run(FFMPEG_BIN, audioCompanionArgs(inPath, outPath));
