// Render the three animated banners for one design snapshot.
//
// Orchestration only. Frame capture is injected exactly as the pre-roll does
// it, so the whole pipeline can be driven in a test by a capturer that writes
// synthetic frames — no Chromium needed to prove the encode, the validation and
// the size budget behave.
//
// Each unit is captured at its own native size. That is the point of animating
// the banner rather than downscaling the pre-roll: 320x50 is not a small
// 300x250, it is a different composition, and a legibility check at one size
// says nothing about the other.

import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { GIF_FRAMES, videoProfile, type GifProfileId } from "../video/profiles";
import type { VideoDesignSnapshot } from "../video/snapshot";
import { FRAME_PATTERN, type FrameCapturer } from "../video/render";
import { GIF_UNITS, gifDocument } from "./compose";
import { encodeGif, validateGif } from "./encode";

export type GifProbe = (file: string) => Promise<{ width: number; height: number; frames: number }>;

export type RenderedGif = {
  profile: GifProfileId;
  file: string;
  width: number;
  height: number;
  frames: number;
  byteSize: number;
  contentType: "image/gif";
  problems: string[];
};

export async function renderAnimatedBanners(args: {
  snapshot: VideoDesignSnapshot;
  workDir: string;
  captureFrames: FrameCapturer;
  probeGif: GifProbe;
  ffmpegPath?: string;
}): Promise<RenderedGif[]> {
  const { snapshot, workDir, captureFrames, probeGif } = args;
  const out: RenderedGif[] = [];

  for (const unit of GIF_UNITS) {
    const spec = videoProfile(unit.id);
    const framesDir = path.join(workDir, `${unit.id}-frames`);
    await mkdir(framesDir, { recursive: true });

    const html = gifDocument({
      unit,
      headline: snapshot.headline,
      // The body line is the pre-roll's subhead where there is one. A banner
      // with an empty second line looks broken rather than minimal, so the
      // domain stands in — it is true, and it is what the static unit shows.
      body: snapshot.subhead || snapshot.domain,
      ctaText: snapshot.ctaText,
      domain: snapshot.domain,
      bgColor: snapshot.bgColor,
      fgColor: snapshot.fgColor,
      accentColor: snapshot.accentColor,
      fontFamily: snapshot.fontFamily,
      logoDataUri: null,
      reducedMotion: snapshot.reducedMotion ?? false,
    });

    await captureFrames({
      html,
      outDir: framesDir,
      frames: GIF_FRAMES,
      width: unit.width,
      height: unit.height,
    });

    // The compositor is the only thing that decides how many frames exist. If
    // the capture disagrees, the timeline did not run and encoding whatever
    // landed would ship a banner that is silently short.
    //
    // Checked by NAME, not just by count. Counting alone passed while the
    // capturer wrote f-0000.png and the encoder asked ffmpeg for
    // frame-0000.png, so the mismatch reached production as an ffmpeg error
    // instead of a clear one here.
    const wanted = Array.from({ length: GIF_FRAMES }, (_, i) =>
      FRAME_PATTERN.replace("%04d", String(i).padStart(4, "0")),
    );
    const present = new Set(await readdir(framesDir));
    const missing = wanted.filter((f) => !present.has(f));
    if (missing.length > 0) {
      throw new Error(
        `${unit.id}: ${missing.length} of ${GIF_FRAMES} frames missing, first is ${missing[0]}`,
      );
    }

    const file = path.join(workDir, `${unit.id}.gif`);
    await encodeGif({ frameDir: framesDir, outPath: file, ffmpegPath: args.ffmpegPath });

    const probed = await probeGif(file);
    const byteSize = (await stat(file)).size;

    out.push({
      profile: unit.id,
      file,
      width: probed.width,
      height: probed.height,
      frames: probed.frames,
      byteSize,
      contentType: "image/gif",
      problems: validateGif({
        width: probed.width,
        height: probed.height,
        frames: probed.frames,
        byteSize,
        expectedWidth: unit.width,
        expectedHeight: unit.height,
        expectedFrames: GIF_FRAMES,
        maxBytes: spec.maxBytes ?? Number.MAX_SAFE_INTEGER,
      }),
    });
  }

  return out;
}
