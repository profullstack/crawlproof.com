// The media contract for a five-second streaming pre-roll: durations, frame
// counts, output profiles and the budgets validation enforces.
//
// Pure constants and arithmetic, kept free of node built-ins for the same
// reason ../formats is — the dashboard renders render-job state and asset sizes
// in a client component, and importing this must not drag ffmpeg or the
// Playwright compositor into the browser bundle.

/**
 * Five seconds, as frames rather than milliseconds.
 *
 * The spec's duration requirement is "exactly 150 frames at 30 fps", and that
 * is deliberately not the same statement as "5000 ms". A frame count is what
 * ffprobe can count and what a compositor can seek to; a millisecond duration
 * is a float that container timebases round. Everything downstream measures
 * frames and derives time from them, never the other way round.
 */
export const PREROLL_FPS = 30;
export const PREROLL_FRAMES = 150;
export const PREROLL_MS = (PREROLL_FRAMES / PREROLL_FPS) * 1000; // 5000

/** Presentation time of a frame index, in milliseconds. */
export function frameTimeMs(frame: number): number {
  return (frame / PREROLL_FPS) * 1000;
}

/**
 * The composition timeline. Three beats, from the spec's §4.2 table.
 *
 * Brand and headline are already legible at frame 0 — the entrance animates
 * around copy that is readable from the first frame rather than revealing it.
 * A five-second ad that spends its first half second assembling itself has
 * spent a tenth of its life saying nothing.
 */
export const TIMELINE = {
  entranceEndMs: 350,
  holdEndMs: 3500,
  endMs: PREROLL_MS,
} as const;

/**
 * Keyframe positions, in seconds, for the HLS packaging.
 *
 * Segments come out ~2s/2s/1s. The third is deliberately short rather than
 * padding the ad to six seconds to land on a round segment size: the viewer's
 * ad is five seconds, and a nominal segment duration is not a reason to make
 * somebody watch a sixth.
 */
export const HLS_KEYFRAME_SECONDS = [0, 2, 4] as const;

/**
 * Audio endpoint tolerance: one AAC frame at 48 kHz.
 *
 * AAC is framed at 1024 samples, so an encoder cannot land an audio track on an
 * arbitrary boundary — it pads to the next frame and signals the remainder as
 * priming/padding. 1024/48000 = 21.333 ms of legitimate rounding. Validation
 * allows exactly one frame of it and no more, which catches a genuinely wrong
 * duration while not failing a correct encode for being AAC.
 */
export const AAC_FRAME_SAMPLES = 1024;
export const AAC_SAMPLE_RATE = 48_000;
export const AUDIO_TOLERANCE_MS = (AAC_FRAME_SAMPLES / AAC_SAMPLE_RATE) * 1000; // 21.333…

export type VideoProfileId =
  | "master_1080p"
  | "mp4_720p"
  | "mp4_480p"
  | "hls"
  | "poster"
  | "captions"
  | "audio";

export type VideoProfile = {
  id: VideoProfileId;
  /** What the object is for, in the advertiser-facing dashboard. */
  label: string;
  width: number | null;
  height: number | null;
  /** Hard ceiling. A profile that exceeds it re-encodes or fails validation. */
  maxBytes: number | null;
  contentType: string;
  /** False for the derived/optional outputs that are not always produced. */
  required: boolean;
};

const KB = 1024;
const MB = 1024 * KB;

/**
 * The outputs one ready revision consists of.
 *
 * The byte ceilings are product targets, not HLS requirements — they exist
 * because a pre-roll that buffers has already failed, and a viewer on a phone
 * pays for these bytes. The 1080p master is the one an advertiser downloads,
 * so it gets the loosest budget; the 480p rendition is what a constrained
 * connection actually receives, so it gets the tightest.
 */
export const VIDEO_PROFILES: VideoProfile[] = [
  {
    id: "master_1080p",
    label: "Downloadable master (1080p)",
    width: 1920,
    height: 1080,
    maxBytes: 3 * MB,
    contentType: "video/mp4",
    required: true,
  },
  {
    id: "mp4_720p",
    label: "Delivery MP4 (720p)",
    width: 1280,
    height: 720,
    maxBytes: Math.round(1.5 * MB),
    contentType: "video/mp4",
    required: true,
  },
  {
    id: "mp4_480p",
    label: "Delivery MP4 (480p)",
    width: 854,
    height: 480,
    maxBytes: 750 * KB,
    contentType: "video/mp4",
    required: true,
  },
  {
    id: "hls",
    label: "HLS package",
    width: null,
    height: null,
    maxBytes: null,
    contentType: "application/vnd.apple.mpegurl",
    required: true,
  },
  {
    id: "poster",
    label: "Poster frame",
    width: 1280,
    height: 720,
    maxBytes: 300 * KB,
    contentType: "image/webp",
    required: true,
  },
  {
    id: "captions",
    label: "Captions (WebVTT)",
    width: null,
    height: null,
    maxBytes: 64 * KB,
    contentType: "text/vtt",
    // Only when the creative has narration. A silent ad has nothing to caption,
    // and an empty VTT would be worse than none.
    required: false,
  },
  {
    id: "audio",
    label: "Audible companion",
    width: null,
    height: null,
    maxBytes: 200 * KB,
    contentType: "audio/mp4",
    // Required only for a property with an audio-only slot. A silent gap does
    // not satisfy the ad requirement there, so when it is required it is
    // genuinely required — see audioRequiredFor() below.
    required: false,
  },
];

export function videoProfile(id: VideoProfileId): VideoProfile {
  const p = VIDEO_PROFILES.find((x) => x.id === id);
  if (!p) throw new Error(`unknown video profile: ${id}`);
  return p;
}

/** The MP4 renditions, largest first — the download master and both deliveries. */
export const MP4_PROFILE_IDS: VideoProfileId[] = ["master_1080p", "mp4_720p", "mp4_480p"];

/**
 * Which profiles a given creative must produce before its revision can publish.
 *
 * `audioMode` comes from the design snapshot: a creative with narration always
 * carries captions and an audio companion, and a silent creative carries an
 * audio companion only if some property it may serve has an audio slot. The
 * caller passes that in rather than this module guessing, because it is a
 * publisher-inventory question, not a media one.
 */
export function requiredProfiles(opts: {
  narrated: boolean;
  audioSlotSupported: boolean;
}): VideoProfileId[] {
  const ids = VIDEO_PROFILES.filter((p) => p.required).map((p) => p.id);
  if (opts.narrated) ids.push("captions");
  if (opts.narrated || opts.audioSlotSupported) ids.push("audio");
  return ids;
}

/**
 * Whether a rendition's byte size is within its budget.
 *
 * Separated from validation so the encoder can check a result and re-encode at
 * a lower bitrate before the whole job is failed for being 40 KB over.
 */
export function withinBudget(id: VideoProfileId, byteSize: number): boolean {
  const max = videoProfile(id).maxBytes;
  return max === null || byteSize <= max;
}
