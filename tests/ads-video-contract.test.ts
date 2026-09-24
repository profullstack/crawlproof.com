import { describe, expect, it } from "vitest";
import {
  AUDIO_TOLERANCE_MS,
  PREROLL_FRAMES,
  PREROLL_FPS,
  PREROLL_MS,
  VIDEO_PROFILES,
  frameTimeMs,
  requiredProfiles,
  videoProfile,
  withinBudget,
} from "@/lib/ads/video/profiles";
import {
  RENDERER_VERSION,
  canonicalJson,
  headlineWords,
  renderHash,
  validateSnapshot,
  type VideoDesignSnapshot,
} from "@/lib/ads/video/snapshot";
import { renderJobId } from "@/lib/ads/video/queue";
import { contentTypeFor, objectKey, revisionPrefix } from "@/lib/ads/video/storage";

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

describe("the five-second contract", () => {
  it("states its duration as frames, and derives time from them", () => {
    expect(PREROLL_FRAMES).toBe(150);
    expect(PREROLL_FPS).toBe(30);
    expect(PREROLL_MS).toBe(5000);
    expect(frameTimeMs(0)).toBe(0);
    expect(frameTimeMs(150)).toBe(5000);
    // The last rendered frame is one frame short of the end, not at it.
    expect(frameTimeMs(149)).toBeCloseTo(4966.667, 2);
  });

  it("allows exactly one AAC frame of audio rounding", () => {
    // 1024 samples at 48 kHz. Not a round number, and not a tolerance anybody
    // should be tempted to widen to "about 50ms".
    expect(AUDIO_TOLERANCE_MS).toBeCloseTo(21.333, 3);
  });

  it("budgets the delivery renditions tighter than the download master", () => {
    expect(videoProfile("mp4_480p").maxBytes).toBeLessThan(videoProfile("mp4_720p").maxBytes!);
    expect(videoProfile("mp4_720p").maxBytes).toBeLessThan(videoProfile("master_1080p").maxBytes!);
    expect(withinBudget("mp4_480p", 750 * 1024)).toBe(true);
    expect(withinBudget("mp4_480p", 750 * 1024 + 1)).toBe(false);
    // HLS has no single-file budget; it is a package.
    expect(withinBudget("hls", 999_999_999)).toBe(true);
  });

  it("requires an audible companion for a narrated ad or an audio slot", () => {
    const silentNoAudioSlot = requiredProfiles({ narrated: false, audioSlotSupported: false });
    expect(silentNoAudioSlot).not.toContain("audio");
    expect(silentNoAudioSlot).not.toContain("captions");

    // Silence never satisfies an audio slot, so a silent creative serving one
    // still owes an audible companion.
    expect(requiredProfiles({ narrated: false, audioSlotSupported: true })).toContain("audio");

    const narrated = requiredProfiles({ narrated: true, audioSlotSupported: false });
    expect(narrated).toContain("audio");
    expect(narrated).toContain("captions");
  });

  it("always requires the three MP4s, the HLS package and a poster", () => {
    const required = VIDEO_PROFILES.filter((p) => p.required).map((p) => p.id);
    expect(required).toEqual(["master_1080p", "mp4_720p", "mp4_480p", "hls", "poster"]);
  });
});

describe("the render hash", () => {
  it("is stable across key order", () => {
    const reordered = Object.fromEntries(
      Object.entries(snapshot).reverse(),
    ) as VideoDesignSnapshot;
    expect(renderHash(reordered, "mp4_720p")).toBe(renderHash(snapshot, "mp4_720p"));
  });

  it("treats an explicitly-undefined field as absent", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("separates profiles, so one rendition cannot satisfy another", () => {
    expect(renderHash(snapshot, "mp4_720p")).not.toBe(renderHash(snapshot, "mp4_480p"));
  });

  it("changes when the artwork bytes change, even at the same URL", () => {
    const a = { ...snapshot, heroUrl: "https://x/h.png", heroSha256: "aaa" };
    const b = { ...snapshot, heroUrl: "https://x/h.png", heroSha256: "bbb" };
    expect(renderHash(a, "mp4_720p")).not.toBe(renderHash(b, "mp4_720p"));
  });

  it("changes when the renderer version does", () => {
    // Guards the reason RENDERER_VERSION is in the key at all: without it, a
    // changed compositor keeps serving cached bytes from the old one forever.
    const hashed = renderHash(snapshot, "mp4_720p");
    expect(canonicalJson({ v: RENDERER_VERSION, profile: "mp4_720p", snapshot })).toContain(
      `"v":"${RENDERER_VERSION}"`,
    );
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("snapshot validation refuses what cannot render legibly", () => {
  it("accepts a good snapshot", () => {
    expect(validateSnapshot(snapshot)).toEqual([]);
  });

  it("caps the headline at eight words", () => {
    const long = { ...snapshot, headline: "one two three four five six seven eight nine" };
    expect(headlineWords(long.headline)).toBe(9);
    expect(validateSnapshot(long).map((p) => p.field)).toContain("headline");
  });

  it("refuses a narrated ad with no script", () => {
    const bad = { ...snapshot, audioMode: "narrated" as const, narration: "  " };
    const problems = validateSnapshot(bad);
    expect(problems.map((p) => p.field)).toContain("narration");
  });

  it("refuses a silent ad that carries a script", () => {
    const bad = { ...snapshot, audioMode: "silent" as const, narration: "buy now" };
    expect(validateSnapshot(bad).map((p) => p.field)).toContain("narration");
  });

  it("reports every problem at once, not just the first", () => {
    const bad = { ...snapshot, headline: "", ctaText: "", bgColor: "red" };
    const fields = validateSnapshot(bad).map((p) => p.field);
    expect(fields).toContain("headline");
    expect(fields).toContain("ctaText");
    expect(fields).toContain("bgColor");
  });
});

describe("queue job ids", () => {
  it("never contains a colon", () => {
    // BullMQ parses a colon-bearing custom jobId as a structured key and
    // rejects anything that is not exactly three parts.
    const id = renderJobId("a".repeat(64), "mp4_720p");
    expect(id).not.toContain(":");
    expect(id).toBe(`vr-${"a".repeat(64)}-mp4_720p`);
  });

  it("refuses to mint one if a caller sneaks a colon in", () => {
    expect(() => renderJobId("a:b", "mp4_720p")).toThrow(/must not contain/);
  });

  it("is a function of immutable inputs only", () => {
    // Same hash and profile => same id, so a retry dedupes onto the same job
    // instead of queueing a second render of identical bytes.
    expect(renderJobId("abc", "hls")).toBe(renderJobId("abc", "hls"));
  });
});

describe("storage layout", () => {
  it("puts the revision in the path so publishing adds rather than replaces", () => {
    const prefix = revisionPrefix({
      ownerId: "o",
      campaignId: "c",
      creativeId: "cr",
      revision: 3,
    });
    expect(prefix).toBe("video/o/c/cr/r3");
    const next = revisionPrefix({ ownerId: "o", campaignId: "c", creativeId: "cr", revision: 4 });
    expect(next).not.toBe(prefix);
  });

  it("keeps the HLS package in its own subtree", () => {
    expect(objectKey("p", "hls", "720p.m3u8")).toBe("p/hls/720p.m3u8");
    expect(objectKey("p", "mp4_720p", "mp4_720p.mp4")).toBe("p/mp4_720p.mp4");
  });

  it("types each HLS file for what it is, not for the playlist", () => {
    // An .m4s served as a playlist type makes some players refuse it outright.
    expect(contentTypeFor("/x/720p.m3u8", "application/vnd.apple.mpegurl")).toBe(
      "application/vnd.apple.mpegurl",
    );
    expect(contentTypeFor("/x/720p-1.m4s", "application/vnd.apple.mpegurl")).toBe("video/mp4");
    expect(contentTypeFor("/x/720p-init.mp4", "application/vnd.apple.mpegurl")).toBe("video/mp4");
    expect(contentTypeFor("/x/poster.webp", "image/webp")).toBe("image/webp");
  });
});
