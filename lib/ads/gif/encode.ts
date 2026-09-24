// Frames to an animated GIF.
//
// Two passes, because GIF carries at most 256 colours and the default palette
// is built from the first frame alone. On a banner whose accent only appears
// once the CTA lifts, a first-frame palette has no entry for it and the final
// beat bands badly. `palettegen` with stats_mode=diff looks at the whole
// sequence and weights what actually changes, which is the part a viewer is
// watching.
//
// The size ceiling is the real constraint: every GIF frame is a full frame of
// indexed colour, so file size scales with frames x area and not with how much
// moved. Flat brand colour is what makes 50 frames affordable; a photographic
// banner would not fit and is not what this renders.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { GIF_FPS } from "../video/profiles";

const run = promisify(execFile);

/** Palette size. 128 is ample for flat UI colour and meaningfully smaller than 256. */
export const GIF_PALETTE_COLORS = 128;

/**
 * Pass one: derive a palette from the whole sequence.
 *
 * `stats_mode=diff` weights pixels that change between frames, so the palette
 * is spent on the moving parts rather than on a large static background that
 * would be well served by a handful of entries anyway.
 */
export function paletteArgs(framePattern: string, palettePath: string): string[] {
  return [
    "-y",
    "-framerate", String(GIF_FPS),
    "-i", framePattern,
    "-vf", `palettegen=max_colors=${GIF_PALETTE_COLORS}:stats_mode=diff`,
    palettePath,
  ];
}

/**
 * Pass two: map the frames through that palette.
 *
 * `dither=bayer:bayer_scale=5` rather than the default error-diffusion. Floyd
 * Steinberg dithering decorrelates neighbouring frames — noise that differs
 * frame to frame defeats GIF's inter-frame compression and can double the file
 * for a banner that barely moves. Ordered dithering is stable across frames, so
 * unchanged regions stay compressible.
 *
 * `diff_mode=rectangle` lets the encoder store only the changed rectangle per
 * frame, which is the single biggest win on a unit whose background is still.
 */
export function gifArgs(framePattern: string, palettePath: string, outPath: string): string[] {
  return [
    "-y",
    "-framerate", String(GIF_FPS),
    "-i", framePattern,
    "-i", palettePath,
    "-lavfi", "paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
    // 0 means loop forever. A banner that plays once and stops is a still image
    // for the rest of the impression.
    "-loop", "0",
    outPath,
  ];
}

export async function encodeGif(input: {
  frameDir: string;
  outPath: string;
  ffmpegPath?: string;
}): Promise<void> {
  const ffmpeg = input.ffmpegPath ?? "ffmpeg";
  const pattern = path.join(input.frameDir, "frame-%04d.png");
  const palette = path.join(input.frameDir, "palette.png");

  await run(ffmpeg, paletteArgs(pattern, palette), { maxBuffer: 16 * 1024 * 1024 });
  await run(ffmpeg, gifArgs(pattern, palette, input.outPath), { maxBuffer: 16 * 1024 * 1024 });
}

/**
 * What a decoded GIF must satisfy to be shippable.
 *
 * Frame count is checked by decoding rather than by trusting the header,
 * for the same reason the pre-roll does it: a truncated write still parses.
 */
export function validateGif(input: {
  width: number;
  height: number;
  frames: number;
  byteSize: number;
  expectedWidth: number;
  expectedHeight: number;
  expectedFrames: number;
  maxBytes: number;
}): string[] {
  const problems: string[] = [];
  if (input.width !== input.expectedWidth || input.height !== input.expectedHeight) {
    problems.push(
      `expected ${input.expectedWidth}x${input.expectedHeight}, got ${input.width}x${input.height}`,
    );
  }
  if (input.frames !== input.expectedFrames) {
    problems.push(`expected ${input.expectedFrames} frames, decoded ${input.frames}`);
  }
  if (input.byteSize <= 0) problems.push("empty file");
  if (input.byteSize > input.maxBytes) {
    problems.push(`${input.byteSize} bytes exceeds the ${input.maxBytes} byte ceiling`);
  }
  return problems;
}
