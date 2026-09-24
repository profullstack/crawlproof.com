import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GIF_UNITS, gifDocument, gifFrameState, gifTimeline, GIF_TIMELINE } from "@/lib/ads/gif/compose";
import { GIF_PALETTE_COLORS, gifArgs, paletteArgs, validateGif } from "@/lib/ads/gif/encode";
import { renderAnimatedBanners } from "@/lib/ads/gif/render";
import { GIF_FPS, GIF_FRAMES, videoProfile } from "@/lib/ads/video/profiles";
import type { VideoDesignSnapshot } from "@/lib/ads/video/snapshot";

const run = promisify(execFile);

const snapshot: VideoDesignSnapshot = {
  headline: "Sources in, feeds out",
  subhead: "An open directory of independent blogs",
  ctaText: "Start free",
  domain: "rssamplifier.com",
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

describe("the banner timeline is a pure function of the frame index", () => {
  it("starts legible and ends at rest", () => {
    const first = gifFrameState(0, false);
    const last = gifFrameState(GIF_FRAMES - 1, false);
    // Frame 0 already shows the ad. A banner that fades in from nothing wastes
    // the impressions of anyone who scrolls past during the entrance.
    expect(first.entrance).toBeGreaterThanOrEqual(0);
    expect(last.entrance).toBe(1);
    // Nearly 1, deliberately not exactly 1. The 50 frames cover [0, 4000) at
    // 80ms each, so the final frame sits at 3920ms and the 4000ms mark IS
    // frame 0 of the next loop. A timeline that put a frame exactly on the end
    // would render the loop point twice and the banner would hitch once per
    // cycle.
    expect(last.cta).toBeGreaterThan(0.99);
    expect(last.cta).toBeLessThan(1);
    expect(last.timeMs).toBe(3920);
  });

  it("ends the loop with the sweep off the unit", () => {
    // The sweep wraps back to frame 0 on every loop. If it were frozen
    // mid-unit at the last frame, every loop would show a visible snap.
    const last = gifFrameState(GIF_FRAMES - 1, false);
    expect(last.sweep).toBeGreaterThanOrEqual(1.5);
  });

  it("covers exactly the four-second loop", () => {
    const t = gifTimeline(false);
    expect(t).toHaveLength(GIF_FRAMES);
    expect(t[0].timeMs).toBe(0);
    expect(t.at(-1)!.timeMs).toBeCloseTo(((GIF_FRAMES - 1) / GIF_FPS) * 1000, 5);
    expect(GIF_TIMELINE.endMs).toBe(4000);
  });

  it("holds every beat at rest under reduced motion", () => {
    for (const f of [0, 10, GIF_FRAMES - 1]) {
      const s = gifFrameState(f, true);
      expect(s).toMatchObject({ entrance: 1, drift: 0, cta: 1 });
    }
  });
});

describe("the document is self-contained", () => {
  it("defines the seek hook and no CSS animation", () => {
    const html = gifDocument({
      unit: GIF_UNITS[0],
      headline: snapshot.headline,
      body: snapshot.subhead!,
      ctaText: snapshot.ctaText,
      domain: snapshot.domain,
      bgColor: snapshot.bgColor,
      fgColor: snapshot.fgColor,
      accentColor: snapshot.accentColor,
      fontFamily: snapshot.fontFamily,
      logoDataUri: null,
      reducedMotion: false,
    });
    expect(html).toContain("window.__seek");
    // A CSS transition or keyframe runs on its own clock and would
    // desynchronise from a frame-by-frame capture.
    expect(html).not.toMatch(/@keyframes|transition:/);
    // Nothing may be fetched: a banner waiting on a webfont captures its first
    // frames unstyled, and every one of those frames ships.
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("escapes copy rather than interpolating it", () => {
    const html = gifDocument({
      unit: GIF_UNITS[0],
      headline: '</style><script>alert(1)</script>',
      body: "x",
      ctaText: "Go",
      domain: "example.com",
      bgColor: "#000",
      fgColor: "#fff",
      accentColor: "#0f0",
      fontFamily: "sans-serif",
      logoDataUri: null,
      reducedMotion: false,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the body line on the unit with no room for it", () => {
    const mobile = GIF_UNITS.find((u) => u.id === "gif_320x50")!;
    expect(mobile.showBody).toBe(false);
    const html = gifDocument({
      unit: mobile,
      headline: "Head",
      body: "SHOULD NOT APPEAR",
      ctaText: "Go",
      domain: "example.com",
      bgColor: "#000",
      fgColor: "#fff",
      accentColor: "#0f0",
      fontFamily: "sans-serif",
      logoDataUri: null,
      reducedMotion: false,
    });
    expect(html).not.toContain("SHOULD NOT APPEAR");
  });
});

describe("the encoder arguments say what they mean", () => {
  it("derives the palette from the whole sequence, not frame one", () => {
    const a = paletteArgs("f-%04d.png", "p.png").join(" ");
    expect(a).toContain(`palettegen=max_colors=${GIF_PALETTE_COLORS}:stats_mode=diff`);
  });

  it("uses ordered dithering and rectangle diffs", () => {
    const a = gifArgs("f-%04d.png", "p.png", "o.gif").join(" ");
    // Error-diffusion dithering decorrelates neighbouring frames and defeats
    // GIF's inter-frame compression on a banner that barely moves.
    expect(a).toContain("dither=bayer");
    expect(a).toContain("diff_mode=rectangle");
    // 0 is loop forever; a banner that stops is a still image for the rest of
    // the impression.
    expect(a).toContain("-loop 0");
  });
});

describe("validation refuses what cannot be trafficked", () => {
  const base = {
    width: 300, height: 250, frames: GIF_FRAMES, byteSize: 1000,
    expectedWidth: 300, expectedHeight: 250, expectedFrames: GIF_FRAMES, maxBytes: 150 * 1024,
  };
  it("accepts a conforming banner", () => {
    expect(validateGif(base)).toEqual([]);
  });
  it("rejects the wrong size, a short loop and an oversized file", () => {
    expect(validateGif({ ...base, width: 728 })[0]).toMatch(/expected 300x250/);
    expect(validateGif({ ...base, frames: 12 })[0]).toMatch(/expected 50 frames/);
    expect(validateGif({ ...base, byteSize: 200 * 1024 })[0]).toMatch(/exceeds/);
  });
});

// The real encode, driven by a synthetic capturer. No browser is involved:
// this proves the ffmpeg pipeline, the probe and the budget, which is what
// breaks silently.
describe("end to end through real ffmpeg", () => {
  it("produces three looping banners inside their size budgets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gif-pipeline-"));
    try {
      // Frames that actually change, so palettegen and the diff encoder have
      // something to do — a constant image would prove nothing about either.
      const captureFrames = async (a: {
        outDir: string; frames: number; width: number; height: number;
      }) => {
        for (let i = 0; i < a.frames; i++) {
          const shift = Math.round((i / a.frames) * a.width);
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${a.width}" height="${a.height}">
            <rect width="100%" height="100%" fill="#12161f"/>
            <rect x="${shift}" y="0" width="40" height="${a.height}" fill="#6ee7b7"/>
            <rect x="8" y="8" width="${Math.max(1, a.width - 16)}" height="10" fill="#e7e9ee"/>
          </svg>`;
          const svgPath = path.join(a.outDir, `f-${i}.svg`);
          await writeFile(svgPath, svg, "utf8");
          await run("ffmpeg", ["-y", "-v", "error", "-i", svgPath,
            path.join(a.outDir, `frame-${String(i).padStart(4, "0")}.png`)]);
          await rm(svgPath);
        }
      };

      const probeGif = async (file: string) => {
        const { stdout } = await run("ffprobe", ["-v", "error", "-count_frames",
          "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames",
          "-of", "json", file]);
        const st = JSON.parse(stdout).streams[0];
        return { width: Number(st.width), height: Number(st.height), frames: Number(st.nb_read_frames) };
      };

      const out = await renderAnimatedBanners({ snapshot, workDir: dir, captureFrames, probeGif });

      expect(out).toHaveLength(3);
      for (const g of out) {
        const spec = videoProfile(g.profile);
        expect(g.problems, `${g.profile}: ${g.problems.join("; ")}`).toEqual([]);
        expect(g.width).toBe(spec.width);
        expect(g.height).toBe(spec.height);
        expect(g.frames).toBe(GIF_FRAMES);
        expect(g.byteSize).toBeGreaterThan(0);
        expect(g.byteSize).toBeLessThanOrEqual(spec.maxBytes!);
        // It must actually be a GIF: the first bytes are the signature, and a
        // trailing 0x3B is the terminator a truncated write would lack.
        const bytes = await readFile(g.file);
        expect(bytes.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a$/);
        expect(bytes.at(-1)).toBe(0x3b);
        // NETSCAPE2.0 is how a GIF declares an infinite loop.
        expect(bytes.includes(Buffer.from("NETSCAPE2.0", "ascii"))).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
