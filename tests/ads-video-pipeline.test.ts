// End-to-end render: synthetic frames -> ffmpeg -> validated assets.
//
// The other video tests assert arguments and evaluate probe data as fixtures,
// which is fast and catches the logic. This one runs the actual encoders,
// because the spec is explicit that a generated filename or a five-second timer
// is not evidence a pre-roll works — and because the things most likely to be
// wrong (a GOP that does not land on the segment boundary, a rendition that
// exceeds its budget, an fMP4 package missing its init map) are only observable
// in real output.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeAudioCompanion, FFMPEG_BIN, FFPROBE_BIN, fitNarration, run } from "@/lib/ads/video/encode";
import { mp4Args } from "@/lib/ads/video/encode";
import { renderPreroll, narrationVtt, type FrameCapturer } from "@/lib/ads/video/render";
import { probeMedia, evaluateProbe, validateMediaPlaylist } from "@/lib/ads/video/validate";
import { NARRATION_BUDGET_MS, PREROLL_FRAMES, videoProfile } from "@/lib/ads/video/profiles";
import type { VideoDesignSnapshot } from "@/lib/ads/video/snapshot";

async function haveFfmpeg(): Promise<boolean> {
  try {
    await run(FFMPEG_BIN, ["-version"], 10_000);
    await run(FFPROBE_BIN, ["-version"], 10_000);
    return true;
  } catch {
    return false;
  }
}

const snapshot: VideoDesignSnapshot = {
  headline: "Sources in, feeds out",
  subhead: "Every source, one feed.",
  ctaText: "Start free",
  domain: "nichedb.dev",
  bgColor: "#12161f",
  fgColor: "#e7e9ee",
  accentColor: "#6ee7b7",
  fontFamily: "system-ui, sans-serif",
  logoUrl: null,
  logoSha256: null,
  heroUrl: null,
  heroSha256: null,
  audioMode: "silent",
  narration: null,
  locale: "en",
  reducedMotion: false,
};

/**
 * Stands in for the Playwright capturer.
 *
 * Generates 150 real 1920x1080 PNGs with ffmpeg's own test source rather than
 * launching Chromium: this test is about the encode, package and validate
 * stages, and a browser here would make it slow and flaky without testing
 * anything the compositor tests do not already cover. The frames are genuinely
 * different from one another, which matters — a run of 150 identical frames
 * compresses to almost nothing and would let a broken bitrate ladder pass.
 */
const syntheticCapturer: FrameCapturer = async ({ outDir, frames, width, height }) => {
  await run(FFMPEG_BIN, [
    "-y",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${width}x${height}:rate=30`,
    "-frames:v",
    String(frames),
    path.join(outDir, "f-%04d.png"),
  ], 240_000);
};

let ffmpegAvailable = false;
let workDir = "";

beforeAll(async () => {
  ffmpegAvailable = await haveFfmpeg();
  if (ffmpegAvailable) workDir = await mkdtemp(path.join(tmpdir(), "ad-video-test-"));
}, 60_000);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
});

describe("a snapshot renders to validated media", () => {
  it(
    "produces three MP4s, an HLS package and a poster, all passing validation",
    async () => {
      if (!ffmpegAvailable) {
        // Deliberately loud rather than a silent skip: a green suite on a box
        // without ffmpeg must not be mistaken for this having passed.
        console.warn("[ads-video-pipeline] ffmpeg/ffprobe absent — encode test not run");
        expect(ffmpegAvailable).toBe(false);
        return;
      }

      const { assets, problems } = await renderPreroll({
        snapshot,
        workDir,
        captureFrames: syntheticCapturer,
      });

      // Nothing failed validation anywhere in the pipeline.
      expect(problems).toEqual([]);

      const byProfile = Object.fromEntries(assets.map((a) => [a.profile, a]));
      expect(Object.keys(byProfile).sort()).toEqual(
        ["hls", "master_1080p", "mp4_480p", "mp4_720p", "poster"].sort(),
      );

      // Every MP4 decodes to exactly 150 frames at exactly 30fps, in H.264
      // 8-bit 4:2:0, at its profile's dimensions and inside its byte budget.
      for (const id of ["master_1080p", "mp4_720p", "mp4_480p"] as const) {
        const asset = byProfile[id];
        const probe = await probeMedia(asset.filePath);
        const result = evaluateProbe(probe, id, asset.byteSize);
        expect(result.problems, `${id}: ${JSON.stringify(result.problems)}`).toEqual([]);
        expect(result.measured.frames).toBe(PREROLL_FRAMES);
        expect(result.measured.fps).toBe(30);
        expect(result.measured.videoCodec).toBe("h264");
        expect(result.measured.pixFmt).toBe("yuv420p");
        expect(result.measured.width).toBe(videoProfile(id).width);
        expect(asset.byteSize).toBeLessThanOrEqual(videoProfile(id).maxBytes!);
        expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      }

      // The HLS package is a finite VOD playlist with an init map, and its
      // segments add up to five seconds — not to six, which is what padding to
      // a round segment size would produce.
      const hls = byProfile.hls;
      const hlsDir = path.dirname(hls.filePath);
      for (const name of ["720p", "480p"]) {
        const playlist = await readFile(path.join(hlsDir, `${name}.m3u8`), "utf8");
        expect(validateMediaPlaylist(playlist), `${name}.m3u8`).toEqual([]);
        expect(playlist).toContain("#EXT-X-ENDLIST");
        expect(playlist).toContain("#EXT-X-MAP");
      }

      // fMP4: an init fragment plus .m4s media segments actually on disk.
      const hlsFiles = await readdir(hlsDir);
      expect(hlsFiles).toContain("720p-init.mp4");
      expect(hlsFiles.filter((f) => f.endsWith(".m4s")).length).toBeGreaterThanOrEqual(6);

      const master = await readFile(hls.filePath, "utf8");
      expect(master).toContain("#EXTM3U");
      expect(master).toContain("RESOLUTION=1280x720");
      expect(master).toContain("RESOLUTION=854x480");
      // Never claimed, because we do not guarantee it.
      expect(master).not.toContain("EXT-X-INDEPENDENT-SEGMENTS");

      // The CODECS declaration must describe what was actually encoded. These
      // renditions are silent, so naming an audio codec would be an audio
      // track a player waits for and never receives; and the level has to be
      // the one in the bitstream, not a guess.
      expect(master).not.toContain("mp4a");
      const declared = [...master.matchAll(/CODECS="([^"]+)"/g)].map((m) => m[1]);
      expect(declared.length).toBe(2);
      for (const codec of declared) {
        expect(codec, `codecs=${codec}`).toMatch(/^avc1\.[0-9A-F]{6}$/);
      }

      expect(byProfile.poster.byteSize).toBeGreaterThan(0);
      expect(byProfile.poster.contentType).toBe("image/webp");
    },
    600_000,
  );

  it("refuses a snapshot that cannot render, before spending a worker on it", async () => {
    await expect(
      renderPreroll({
        snapshot: { ...snapshot, headline: "" },
        workDir: workDir || tmpdir(),
        captureFrames: async () => {
          throw new Error("capturer must not be reached");
        },
      }),
    ).rejects.toThrow(/snapshot rejected/);
  });

  it("refuses a narrated snapshot with no audio track", async () => {
    // Encoding anyway would produce a silent ad recorded as an audible one.
    await expect(
      renderPreroll({
        snapshot: { ...snapshot, audioMode: "narrated", narration: "Try NicheDB today." },
        workDir: workDir || tmpdir(),
        audioPath: null,
        captureFrames: async () => {
          throw new Error("capturer must not be reached");
        },
      }),
    ).rejects.toThrow(/no audio track/);
  });

  it("fails when the compositor returns the wrong number of frames", async () => {
    if (!ffmpegAvailable) return;
    const short = await mkdtemp(path.join(tmpdir(), "ad-video-short-"));
    try {
      await expect(
        renderPreroll({
          snapshot,
          workDir: short,
          captureFrames: async ({ outDir, width, height }) => {
            // 149, not 150.
            await run(FFMPEG_BIN, [
              "-y", "-nostdin", "-f", "lavfi",
              "-i", `testsrc2=size=${width}x${height}:rate=30`,
              "-frames:v", "149",
              path.join(outDir, "f-%04d.png"),
            ], 240_000);
          },
        }),
      ).rejects.toThrow(/produced 149 frames/);
    } finally {
      await rm(short, { recursive: true, force: true }).catch(() => {});
    }
  }, 300_000);

  it("writes one caption cue across the whole ad", () => {
    // Five seconds is one sentence; splitting it into cues would be inventing
    // timings nobody measured.
    const vtt = narrationVtt("  Try NicheDB\n  today.  ");
    expect(vtt).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nTry NicheDB today.\n");
  });
  it("gives a narrated encode an audio track exactly as long as the picture", async () => {
    // Every narration is shorter than its ad: a five-second read is about two
    // and a half seconds of speech. This asserts the padding against real
    // ffmpeg, because the obvious spelling of it does not work — `-shortest`
    // keys off input durations in ffmpeg 4.x, so a padded filter output either
    // left the short track alone or dropped the stream entirely, and both
    // shipped past unit tests that only inspected the argument list.
    const dir = await mkdtemp(path.join(tmpdir(), "narrated-"));
    try {
      // A 2.3s tone stands in for the voiceover.
      const audio = path.join(dir, "narration.mp3");
      await run(FFMPEG_BIN, ["-y", "-v", "error", "-f", "lavfi", "-i",
        "sine=frequency=440:duration=2.3", audio], 60_000);

      // 150 frames of flat colour: the picture is not what is under test.
      for (let i = 0; i < 150; i++) {
        await run(FFMPEG_BIN, ["-y", "-v", "error", "-f", "lavfi", "-i",
          "color=c=#12161f:s=320x180:d=1", "-frames:v", "1",
          path.join(dir, `f-${String(i).padStart(4, "0")}.png`)], 60_000);
      }

      const out = path.join(dir, "narrated.mp4");
      await run(FFMPEG_BIN, mp4Args({
        framePattern: path.join(dir, "f-%04d.png"),
        audioPath: audio,
        outPath: out,
        profile: "mp4_480p",
        videoKbps: 800,
      }), 180_000);

      const probed = await run(FFPROBE_BIN, ["-v", "error", "-show_entries",
        "stream=codec_type,duration", "-of", "json", out], 60_000);
      const streams = JSON.parse(String(probed)).streams as { codec_type: string; duration?: string }[];

      const audioStream = streams.find((st) => st.codec_type === "audio");
      // The track must exist at all: a silent "narrated" ad is the bug that
      // reached production.
      expect(audioStream, "no audio stream in a narrated encode").toBeTruthy();

      const seconds = Number(audioStream!.duration);
      // Within one AAC frame of five seconds, which is what validation demands.
      expect(Math.abs(seconds - 5)).toBeLessThan(0.05);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it("fits a read that is longer than the advert instead of cutting it", async () => {
    // The bug, against real ffmpeg. Production reads ran to 8.405s in a
    // five-second spot, and every consumer bounded its output at five — so the
    // last three seconds, which is the call to action and the domain, were
    // simply not in the file.
    //
    // The discriminator is where the silence starts. A truncated read has none
    // at all: it is signal right up to the final sample. A fitted one is signal
    // for its budget and silence for the tail, which is what this asserts.
    const dir = await mkdtemp(path.join(tmpdir(), "overlong-"));
    try {
      const audio = path.join(dir, "narration.mp3");
      await run(FFMPEG_BIN, ["-y", "-v", "error", "-f", "lavfi", "-i",
        "sine=frequency=440:duration=8.405", audio], 60_000);

      const fitted = path.join(dir, "fitted.wav");
      const fit = await fitNarration({ inPath: audio, outPath: fitted });
      expect(fit.tempo).toBeGreaterThan(2);

      // Through ffprobe rather than ffmpeg: silencedetect reports on stderr,
      // and reading it as frame tags puts the answer on stdout where it can be
      // parsed rather than scraped out of a log.
      const detected = await run(FFPROBE_BIN, ["-v", "error", "-f", "lavfi",
        "-i", `amovie=${fitted},silencedetect=noise=-50dB:d=0.3`,
        "-show_entries", "frame_tags=lavfi.silence_start", "-of", "json"], 60_000);
      const startedAt = /"lavfi\.silence_start":\s*"([\d.]+)"/.exec(String(detected));
      expect(startedAt, "no trailing silence: the read was cut, not fitted").toBeTruthy();
      expect(Number(startedAt![1])).toBeCloseTo(NARRATION_BUDGET_MS / 1000, 1);

      // And the companion a music player actually fetches is one spot long,
      // where it used to be however long the voice happened to take.
      const companion = path.join(dir, "audio.m4a");
      await encodeAudioCompanion(fitted, companion);
      const probe = await probeMedia(companion);
      const stream = probe.streams.find((s) => s.codec_type === "audio");
      expect(Math.abs(Number(stream!.duration) - 5)).toBeLessThan(0.05);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it("pads a short read out to the advert, so the companion is never short", async () => {
    // The other half of the same fault: a 2.3s read produced a 2.3s audio
    // companion, and a player handed a track shorter than the break it is
    // filling is entitled to move on early.
    const dir = await mkdtemp(path.join(tmpdir(), "shortread-"));
    try {
      const audio = path.join(dir, "narration.mp3");
      await run(FFMPEG_BIN, ["-y", "-v", "error", "-f", "lavfi", "-i",
        "sine=frequency=440:duration=2.3", audio], 60_000);

      const fitted = path.join(dir, "fitted.wav");
      const fit = await fitNarration({ inPath: audio, outPath: fitted });
      // It fits, so it is not resampled: atempo is not free of artefacts.
      expect(fit.tempo).toBe(1);

      const companion = path.join(dir, "audio.m4a");
      await encodeAudioCompanion(fitted, companion);
      const probe = await probeMedia(companion);
      const stream = probe.streams.find((s) => s.codec_type === "audio");
      expect(Math.abs(Number(stream!.duration) - 5)).toBeLessThan(0.05);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);

});
