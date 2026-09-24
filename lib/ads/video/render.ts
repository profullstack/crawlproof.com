// Snapshot in, validated assets out.
//
// The orchestration only. Frame capture is injected rather than imported so
// that Playwright stays in the worker image where it belongs, and so the
// pipeline can be driven in a test by a capturer that writes synthetic frames
// instead of launching Chromium for 150 screenshots.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MP4_PROFILE_IDS,
  PREROLL_FRAMES,
  requiredProfiles,
  videoProfile,
  withinBudget,
  type VideoProfileId,
} from "./profiles";
import { renderAnimatedBanners, type GifProbe } from "../gif/render";
import { composeDocument, type ComposeAssets } from "./compose";
import { validateSnapshot, type VideoDesignSnapshot } from "./snapshot";
import {
  AAC_LC_CODEC,
  avcCodecString,
  encodeAudioCompanion,
  encodeMp4,
  extractPoster,
  multivariantPlaylist,
  packageHls,
} from "./encode";
import { evaluateProbe, probeMedia, validateMediaPlaylist, type ValidationProblem } from "./validate";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * Writes `frames` PNGs into `outDir` named `f-0000.png` … and resolves.
 *
 * The contract the worker's Playwright implementation satisfies, and the seam
 * the tests substitute at.
 */
export type FrameCapturer = (args: {
  html: string;
  outDir: string;
  frames: number;
  width: number;
  height: number;
}) => Promise<void>;

export const FRAME_PATTERN = "f-%04d.png";
export function framePath(dir: string, i: number): string {
  return path.join(dir, `f-${String(i).padStart(4, "0")}.png`);
}

/**
 * Starting bitrates, chosen to land comfortably inside each profile's byte
 * budget rather than at its edge.
 *
 * A five-second 1080p file at 4.8 Mbps is exactly 3 MB, so encoding at 4.8
 * would put every render one rounding error from failing validation. 4.0 leaves
 * room for the container overhead and the moov atom.
 */
const START_KBPS: Record<string, number> = {
  master_1080p: 4000,
  mp4_720p: 2000,
  mp4_480p: 1000,
};

/** How many times a rendition may be re-encoded lower before the job fails. */
const BUDGET_RETRIES = 2;

export type RenderedAsset = {
  profile: VideoProfileId;
  /** Path on disk, relative to the job's working directory. */
  filePath: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  codecs: string | null;
  validation: { ok: boolean; problems: ValidationProblem[] };
  /** For the HLS profile: the segment and init files that travel with it. */
  extraFiles?: string[];
};

export type RenderResult = {
  assets: RenderedAsset[];
  problems: ValidationProblem[];
};

export class RenderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RenderError";
  }
}

async function fileFacts(filePath: string) {
  const bytes = await readFile(filePath);
  return {
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Encode one MP4 rendition, lowering the bitrate if it lands over budget.
 *
 * Retrying is worth the extra encode: the alternative is failing an otherwise
 * correct render because a dense hero image pushed a rendition 5% over, which
 * an advertiser cannot act on and which a lower bitrate fixes invisibly.
 */
async function encodeWithinBudget(args: {
  profile: VideoProfileId;
  framePattern: string;
  audioPath: string | null;
  outPath: string;
}): Promise<number> {
  let kbps = START_KBPS[args.profile] ?? 2000;

  for (let attempt = 0; attempt <= BUDGET_RETRIES; attempt++) {
    await encodeMp4({
      framePattern: args.framePattern,
      audioPath: args.audioPath,
      outPath: args.outPath,
      profile: args.profile,
      videoKbps: kbps,
    });
    const size = statSync(args.outPath).size;
    if (withinBudget(args.profile, size)) return size;

    const max = videoProfile(args.profile).maxBytes!;
    // Aim at 90% of budget rather than exactly at it, so the next attempt has
    // margin instead of landing on the boundary again.
    kbps = Math.max(200, Math.floor((kbps * max * 0.9) / size));
  }

  throw new RenderError(
    `${args.profile} exceeds its byte budget after ${BUDGET_RETRIES + 1} attempts`,
    "budget_exceeded",
  );
}

/**
 * Render one design snapshot into every required output.
 *
 * `audioPath` is a narration track the caller has already synthesised; this
 * module does not do text-to-speech. Keeping that out means a render is pure
 * media work with no model call in it, which is what lets the same snapshot be
 * re-rendered years later and produce the same bytes.
 */
export async function renderPreroll(args: {
  snapshot: VideoDesignSnapshot;
  assets?: ComposeAssets;
  workDir: string;
  captureFrames: FrameCapturer;
  /** Supplied by the worker; omitted in tests that only exercise the video. */
  probeGif?: GifProbe;
  audioPath?: string | null;
  audioSlotSupported?: boolean;
}): Promise<RenderResult> {
  const { snapshot, workDir, captureFrames } = args;

  const snapshotProblems = validateSnapshot(snapshot);
  if (snapshotProblems.length > 0) {
    throw new RenderError(
      `snapshot rejected: ${snapshotProblems.map((p) => `${p.field} (${p.reason})`).join(", ")}`,
      "invalid_snapshot",
    );
  }

  const narrated = snapshot.audioMode === "narrated";
  const audioPath = narrated ? (args.audioPath ?? null) : null;
  if (narrated && !audioPath) {
    // The snapshot says narrated and no track arrived. Encoding anyway would
    // produce a silent "narrated" ad, and a silent audio companion is the one
    // outcome the spec singles out as never acceptable.
    throw new RenderError("narrated snapshot with no audio track", "missing_narration_audio");
  }

  const framesDir = path.join(workDir, "frames");
  const outDir = path.join(workDir, "out");
  await mkdir(framesDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  // 1. Compose and capture. Always at the master's dimensions; the renditions
  //    are downscales of these pixels, not separate layouts.
  const html = composeDocument(snapshot, args.assets ?? { logo: null, hero: null });
  await captureFrames({ html, outDir: framesDir, frames: PREROLL_FRAMES, width: 1920, height: 1080 });

  const captured = (await readdir(framesDir)).filter((f) => f.endsWith(".png"));
  if (captured.length !== PREROLL_FRAMES) {
    throw new RenderError(
      `compositor produced ${captured.length} frames, expected ${PREROLL_FRAMES}`,
      "frame_count",
    );
  }

  const framePattern = path.join(framesDir, FRAME_PATTERN);
  const assets: RenderedAsset[] = [];
  const problems: ValidationProblem[] = [];

  // 2. The MP4 renditions.
  for (const profile of MP4_PROFILE_IDS) {
    const outPath = path.join(outDir, `${profile}.mp4`);
    await encodeWithinBudget({ profile, framePattern, audioPath, outPath });

    const probe = await probeMedia(outPath);
    const facts = await fileFacts(outPath);
    const result = evaluateProbe(probe, profile, facts.byteSize, { expectAudio: !!audioPath });
    if (!result.ok) problems.push(...result.problems);

    const spec = videoProfile(profile);
    assets.push({
      profile,
      filePath: outPath,
      contentType: spec.contentType,
      byteSize: facts.byteSize,
      sha256: facts.sha256,
      width: result.measured.width,
      height: result.measured.height,
      durationMs: result.measured.frames !== null ? (result.measured.frames / 30) * 1000 : null,
      codecs: result.measured.videoCodec,
      validation: { ok: result.ok, problems: result.problems },
    });
  }

  // 3. HLS, packaged by stream-copying the delivery renditions so the segments
  //    carry exactly the media the advertiser approved.
  const hlsDir = path.join(outDir, "hls");
  await mkdir(hlsDir, { recursive: true });
  const renditions: { name: string; width: number; height: number; bandwidth: number; codecs: string }[] = [];

  for (const profile of ["mp4_720p", "mp4_480p"] as const) {
    const spec = videoProfile(profile);
    const name = `${spec.height}p`;
    const renditionPath = path.join(outDir, `${profile}.mp4`);
    await packageHls({ inPath: renditionPath, outDir: hlsDir, name });

    const playlist = await readFile(path.join(hlsDir, `${name}.m3u8`), "utf8");
    problems.push(...validateMediaPlaylist(playlist));

    // Declare what this rendition actually is. Both halves used to be
    // hardcoded and both were wrong: the level said 4.0 for a stream encoded
    // at 3.1, and every silent ad advertised an AAC track it did not have.
    // A player reads CODECS before fetching a segment, so an audio codec named
    // here is an audio track it will wait for.
    const probe = await probeMedia(renditionPath);
    const v = probe.streams.find((st) => st.codec_type === "video");
    const hasAudio = probe.streams.some((st) => st.codec_type === "audio");
    const codecs = [avcCodecString(v?.profile, v?.level), ...(hasAudio ? [AAC_LC_CODEC] : [])].join(",");

    const mp4Size = statSync(renditionPath).size;
    renditions.push({
      name,
      width: spec.width!,
      height: spec.height!,
      // Peak bandwidth, derived from the rendition we actually produced.
      bandwidth: Math.round((mp4Size * 8) / 5),
      codecs,
    });
  }

  const master = multivariantPlaylist(renditions);
  const masterPath = path.join(hlsDir, "master.m3u8");
  await writeFile(masterPath, master, "utf8");

  const hlsFiles = (await readdir(hlsDir)).map((f) => path.join(hlsDir, f));
  const hlsFacts = await fileFacts(masterPath);
  assets.push({
    profile: "hls",
    filePath: masterPath,
    contentType: videoProfile("hls").contentType,
    byteSize: hlsFacts.byteSize,
    sha256: hlsFacts.sha256,
    width: null,
    height: null,
    durationMs: null,
    codecs: renditions.map((r) => r.codecs).join(" "),
    validation: { ok: true, problems: [] },
    extraFiles: hlsFiles.filter((f) => f !== masterPath),
  });

  // 4. Poster, from the settled hold rather than the entrance.
  const posterPath = path.join(outDir, "poster.webp");
  await extractPoster(path.join(outDir, "master_1080p.mp4"), posterPath);
  const posterFacts = await fileFacts(posterPath);
  assets.push({
    profile: "poster",
    filePath: posterPath,
    contentType: videoProfile("poster").contentType,
    byteSize: posterFacts.byteSize,
    sha256: posterFacts.sha256,
    width: 1280,
    height: 720,
    durationMs: null,
    codecs: null,
    validation: { ok: true, problems: [] },
  });

  // 5. Captions and the audible companion, when there is narration to carry.
  if (narrated && snapshot.narration) {
    const vttPath = path.join(outDir, "captions.vtt");
    await writeFile(vttPath, narrationVtt(snapshot.narration), "utf8");
    const vttFacts = await fileFacts(vttPath);
    assets.push({
      profile: "captions",
      filePath: vttPath,
      contentType: videoProfile("captions").contentType,
      byteSize: vttFacts.byteSize,
      sha256: vttFacts.sha256,
      width: null,
      height: null,
      durationMs: null,
      codecs: null,
      validation: { ok: true, problems: [] },
    });
  }

  if (audioPath && (narrated || args.audioSlotSupported)) {
    const companionPath = path.join(outDir, "audio.m4a");
    await encodeAudioCompanion(audioPath, companionPath);
    const probe = await probeMedia(companionPath);
    const facts = await fileFacts(companionPath);
    const audioStream = probe.streams.find((s) => s.codec_type === "audio");
    assets.push({
      profile: "audio",
      filePath: companionPath,
      contentType: videoProfile("audio").contentType,
      byteSize: facts.byteSize,
      sha256: facts.sha256,
      width: null,
      height: null,
      durationMs: audioStream?.duration ? Number(audioStream.duration) * 1000 : null,
      codecs: audioStream?.codec_name ?? null,
      validation: { ok: true, problems: [] },
    });
  }

  // 6. Everything the caller said this creative owes must be present.
  const required = requiredProfiles({
    narrated,
    audioSlotSupported: !!args.audioSlotSupported,
  });
  for (const id of required) {
    if (!assets.some((a) => a.profile === id)) {
      problems.push({ check: "required profile", expected: id, actual: "absent" });
    }
  }

  // The animated banners. Rendered from the same snapshot so the campaign reads
  // as one thing across the pre-roll and the display units, but laid out at
  // each unit's own size rather than downscaled — 320x50 is not a small
  // 300x250, it is a different composition.
  //
  // They are optional profiles: a banner that fails to encode must not fail a
  // revision whose video is fine, because the video is what the advertiser is
  // waiting for. The problems are recorded either way.
  if (args.probeGif) {
    try {
      const gifs = await renderAnimatedBanners({
        snapshot,
        workDir,
        captureFrames,
        probeGif: args.probeGif,
      });
      for (const g of gifs) {
        const facts = await fileFacts(g.file);
        assets.push({
          profile: g.profile,
          filePath: g.file,
          contentType: g.contentType,
          byteSize: facts.byteSize,
          sha256: facts.sha256,
          width: g.width,
          height: g.height,
          // A GIF's duration is its frame delays summed; the loop is what
          // matters and it is fixed, so nothing here needs to carry it.
          durationMs: null,
          codecs: null,
          validation: {
            ok: g.problems.length === 0,
            problems: g.problems.map((p) => ({ check: g.profile, expected: "conforming", actual: p })),
          },
        });
      }
    } catch (err) {
      problems.push({
        check: "animated banners",
        expected: "three units",
        actual: (err as Error).message,
      });
    }
  }

  return { assets, problems };
}

/**
 * A single caption cue spanning the ad.
 *
 * Five seconds of narration is one sentence; splitting it into timed cues would
 * be inventing timings we did not measure. One cue over the whole timeline is
 * honest and is what a five-second read actually looks like.
 */
export function narrationVtt(narration: string): string {
  // Collapse every run of whitespace, not just newlines: a script arrives with
  // the indentation of wherever it was authored, and "NicheDB   today" is what
  // a viewer would otherwise see rendered as a caption.
  const text = narration.trim().replace(/\s+/g, " ");
  return `WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n${text}\n`;
}
