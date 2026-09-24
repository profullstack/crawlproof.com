import { describe, expect, it } from "vitest";
import {
  composeDocument,
  escapeHtml,
  frameState,
  safeDataUri,
  timeline,
} from "@/lib/ads/video/compose";
import type { VideoDesignSnapshot } from "@/lib/ads/video/snapshot";
import { AAC_LC_CODEC, avcCodecString, GOP_FRAMES, hlsArgs, mp4Args, multivariantPlaylist, posterArgs } from "@/lib/ads/video/encode";
import {
  evaluateProbe,
  parseRational,
  probeArgs,
  validateMediaPlaylist,
  type ProbeResult,
} from "@/lib/ads/video/validate";
import { PREROLL_FRAMES, TIMELINE } from "@/lib/ads/video/profiles";

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

describe("the composition is deterministic", () => {
  it("is a pure function of the frame index", () => {
    expect(frameState(73, false)).toEqual(frameState(73, false));
    expect(timeline(false)).toHaveLength(PREROLL_FRAMES);
  });

  it("says who is advertising from the very first frame, and finishes early", () => {
    // The rule this replaces required the whole headline to be legible at frame
    // 0. Honouring it produced an ad where nothing visibly happened across five
    // seconds — frames a second apart were indistinguishable, which is its own
    // way of saying nothing. The rule is now narrower and still protects the
    // opening instant: the brand is visible immediately, and the copy finishes
    // assembling inside the first quarter of the ad rather than half of it.
    const doc = composeDocument(snapshot);
    expect(doc).toContain("0.35 + 0.65 * b");
    // The headline build completes well before the midpoint.
    expect(doc).toContain("800 / (words.length - 1)");
    expect(doc).toContain("(t - i * per) / 420");
    // And the CTA lands early enough to be on screen for roughly the back half.
    expect(doc).toContain("(t - 1900) / 700");
  });

  it("runs its three beats in order and finishes settled", () => {
    // Frame boundaries do not land on the beat boundaries (350ms is frame
    // 10.5), so assert on the frames either side rather than on a rounded one.
    const lastEntranceFrame = Math.floor((TIMELINE.entranceEndMs / 1000) * 30); // 10
    const beforeHold = frameState(lastEntranceFrame, false);
    expect(beforeHold.entrance).toBeLessThan(1);
    expect(beforeHold.drift).toBe(0);

    const afterEntrance = frameState(lastEntranceFrame + 1, false);
    expect(afterEntrance.entrance).toBe(1);
    expect(afterEntrance.drift).toBeGreaterThan(0);

    // The CTA beat has not started before the hold ends.
    const lastHoldFrame = Math.floor((TIMELINE.holdEndMs / 1000) * 30); // 105
    expect(frameState(lastHoldFrame, false).cta).toBe(0);
    expect(frameState(lastHoldFrame + 1, false).cta).toBeGreaterThan(0);

    // Each beat is monotonic across the whole timeline.
    const frames = timeline(false);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].entrance).toBeGreaterThanOrEqual(frames[i - 1].entrance);
      expect(frames[i].drift).toBeGreaterThanOrEqual(frames[i - 1].drift);
      expect(frames[i].cta).toBeGreaterThanOrEqual(frames[i - 1].cta);
    }

    expect(frames[PREROLL_FRAMES - 1].cta).toBeGreaterThan(0.9);
  });

  it("holds everything still for a reduced-motion viewer, on the same timeline", () => {
    for (const frame of [0, 40, 149]) {
      const s = frameState(frame, true);
      expect(s.entrance).toBe(1);
      expect(s.drift).toBe(0);
      expect(s.cta).toBe(1);
    }
    // Same number of frames — it is a static composition over five seconds, not
    // a shorter ad.
    expect(timeline(true)).toHaveLength(PREROLL_FRAMES);
  });
});

describe("the composition is closed against its own input", () => {
  it("escapes advertiser copy", () => {
    const evil = {
      ...snapshot,
      headline: `</h1><script>fetch('http://169.254.169.254/')</script>`,
      ctaText: `" onerror="alert(1)`,
    };
    const html = composeDocument(evil);
    expect(html).not.toContain("<script>fetch(");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain(`" onerror="`);
  });

  it("accepts only data: URIs for artwork", () => {
    expect(safeDataUri("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    // Everything else is dropped rather than sanitised — an http URL here would
    // make the renderer a request-forgery primitive on our own network.
    expect(safeDataUri("https://example.com/a.png")).toBeNull();
    expect(safeDataUri("file:///etc/passwd")).toBeNull();
    expect(safeDataUri("javascript:alert(1)")).toBeNull();
    expect(safeDataUri("data:text/html;base64,AAAA")).toBeNull();
  });

  it("references no network origin", () => {
    const html = composeDocument(snapshot, { logo: "https://evil/x.png", hero: null });
    expect(html).not.toContain("https://evil");
    expect(html).not.toMatch(/src="http/);
    expect(html).not.toContain("fonts.googleapis.com");
  });

  it("escapes a basic case correctly", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
});

describe("encoder arguments carry the media contract", () => {
  const args = mp4Args({
    framePattern: "/tmp/f-%04d.png",
    audioPath: null,
    outPath: "/tmp/out.mp4",
    profile: "mp4_720p",
    videoKbps: 2000,
  });

  it("counts frames rather than trusting a duration flag", () => {
    expect(args).toContain("-frames:v");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("150");
    expect(args).not.toContain("-t");
  });

  it("pins H.264 high profile at 8-bit 4:2:0", () => {
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
  });

  it("puts a keyframe on every HLS segment boundary", () => {
    // 0, 2 and 4 seconds at 30fps => every 60 frames.
    expect(GOP_FRAMES).toBe(60);
    expect(args[args.indexOf("-g") + 1]).toBe("60");
    expect(args[args.indexOf("-keyint_min") + 1]).toBe("60");
    // Without this, x264 adds keyframes on scene changes and segment durations
    // start depending on the artwork.
    expect(args[args.indexOf("-sc_threshold") + 1]).toBe("0");
  });

  it("moves the moov atom to the front", () => {
    expect(args[args.indexOf("-movflags") + 1]).toBe("+faststart");
  });

  it("scales explicitly to the profile's size", () => {
    expect(args[args.indexOf("-vf") + 1]).toContain("scale=1280:720");
  });

  it("strips audio from a silent encode and configures AAC-LC for a narrated one", () => {
    expect(args).toContain("-an");
    const narrated = mp4Args({
      framePattern: "/tmp/f-%04d.png",
      audioPath: "/tmp/n.wav",
      outPath: "/tmp/out.mp4",
      profile: "mp4_720p",
      videoKbps: 2000,
    });
    expect(narrated).not.toContain("-an");
    expect(narrated[narrated.indexOf("-c:a") + 1]).toBe("aac");
    expect(narrated[narrated.indexOf("-profile:a") + 1]).toBe("aac_low");
    expect(narrated[narrated.indexOf("-ar") + 1]).toBe("48000");
  });

  it("pads a narration to the length of the picture", () => {
    // Every narration is shorter than its ad — a five-second read is about two
    // and a half seconds of speech. Without the pad the audio stream ended
    // early, which failed the duration check on every narrated render and left
    // players entitled to stop at the end of the track.
    const a = mp4Args({
      framePattern: "f-%04d.png",
      audioPath: "/tmp/narration.mp3",
      outPath: "/tmp/out.mp4",
      profile: "master_1080p",
      videoKbps: 4000,
    }).join(" ");
    expect(a).toContain("-af apad");
    // apad alone runs forever, and -shortest does NOT trim it: in ffmpeg 4.x
    // that flag keys off input durations, so the padded stream either kept the
    // original 2.3s of speech or vanished entirely. The output duration is
    // stated outright instead.
    expect(a).toContain("-t 5");
    expect(a).not.toContain("-shortest");
  });

  it("stream-copies into HLS rather than re-encoding", () => {
    const hls = hlsArgs({ inPath: "/tmp/720.mp4", outDir: "/tmp/hls", name: "720p" });
    // Re-encoding would move the keyframes and break the boundaries the MP4 was
    // encoded to hit.
    expect(hls[hls.indexOf("-c") + 1]).toBe("copy");
    expect(hls[hls.indexOf("-hls_segment_type") + 1]).toBe("fmp4");
    expect(hls[hls.indexOf("-hls_playlist_type") + 1]).toBe("vod");
    expect(hls[hls.indexOf("-hls_time") + 1]).toBe("2");
  });

  it("takes the poster from the settled hold, not the entrance", () => {
    const poster = posterArgs("/tmp/m.mp4", "/tmp/p.webp");
    expect(poster[poster.indexOf("-ss") + 1]).toBe("2");
  });

it("derives the avc1 codec string from what was actually encoded", () => {
    // Shipped renditions probe as High @ 3.1. The hardcoded string said level
    // 4.0 (0x28), which is a promise about the bitstream it does not keep.
    expect(avcCodecString("High", 31)).toBe("avc1.64001F");
    expect(avcCodecString("High", 40)).toBe("avc1.640028");
    expect(avcCodecString("Main", 31)).toBe("avc1.4D001F");
    expect(avcCodecString("Constrained Baseline", 30)).toBe("avc1.42001E");
    // Unknown input falls back to High @ 3.1 rather than emitting nonsense.
    expect(avcCodecString(undefined, undefined)).toBe("avc1.64001F");
  });

  it("never advertises audio for a silent rendition", () => {
    // A player reads CODECS before fetching a segment, so an audio codec named
    // here is an audio track it will wait for. Every ad is silent today.
    const silent = multivariantPlaylist([
      { name: "720p", width: 1280, height: 720, bandwidth: 700000, codecs: avcCodecString("High", 31) },
    ]);
    expect(silent).toContain('CODECS="avc1.64001F"');
    expect(silent).not.toContain(AAC_LC_CODEC);

    const narrated = multivariantPlaylist([
      { name: "720p", width: 1280, height: 720, bandwidth: 700000, codecs: `${avcCodecString("High", 31)},${AAC_LC_CODEC}` },
    ]);
    expect(narrated).toContain(AAC_LC_CODEC);
  });

  it("does not claim independent segments in the multivariant playlist", () => {
    const m = multivariantPlaylist([
      { name: "720p", width: 1280, height: 720, bandwidth: 2_400_000, codecs: "avc1.640028" },
    ]);
    expect(m).toContain("#EXTM3U");
    expect(m).toContain("RESOLUTION=1280x720");
    // Our segments open on a keyframe but are not independently decodable in
    // the sense the tag asserts, and a player acts on that claim.
    expect(m).not.toContain("EXT-X-INDEPENDENT-SEGMENTS");
  });
});

describe("validation measures the decoded output", () => {
  const goodVideo = {
    codec_type: "video",
    codec_name: "h264",
    pix_fmt: "yuv420p",
    width: 1280,
    height: 720,
    r_frame_rate: "30/1",
    nb_read_frames: "150",
  };

  const probe = (streams: Record<string, unknown>[]): ProbeResult =>
    ({ streams }) as ProbeResult;

  it("decodes frames rather than reading the container header", () => {
    // -count_frames is the difference between "the muxer wrote 150" and "150
    // frames decoded".
    expect(probeArgs("/x.mp4")).toContain("-count_frames");
  });

  it("passes a correct encode", () => {
    const r = evaluateProbe(probe([goodVideo]), "mp4_720p", 1_000_000);
    expect(r.ok).toBe(true);
    expect(r.measured.frames).toBe(150);
  });

  it("fails a 149-frame encode that still measures five seconds", () => {
    const r = evaluateProbe(probe([{ ...goodVideo, nb_read_frames: "149" }]), "mp4_720p", 1_000_000);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.check)).toContain("frame count");
  });

  it("fails 29.97 fps", () => {
    expect(parseRational("30000/1001")).toBeCloseTo(29.97, 2);
    const r = evaluateProbe(
      probe([{ ...goodVideo, r_frame_rate: "30000/1001" }]),
      "mp4_720p",
      1_000_000,
    );
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.check)).toContain("frame rate");
  });

  it("fails 10-bit or wrong-size output", () => {
    expect(
      evaluateProbe(probe([{ ...goodVideo, pix_fmt: "yuv420p10le" }]), "mp4_720p", 1).problems.map(
        (p) => p.check,
      ),
    ).toContain("pixel format");
    expect(
      evaluateProbe(probe([{ ...goodVideo, width: 1920, height: 1080 }]), "mp4_720p", 1).problems.map(
        (p) => p.check,
      ),
    ).toContain("width");
  });

  it("fails a rendition over its byte budget", () => {
    const r = evaluateProbe(probe([goodVideo]), "mp4_720p", 2 * 1024 * 1024);
    expect(r.problems.map((p) => p.check)).toContain("byte size");
  });

  it("allows one AAC frame of audio rounding but not two", () => {
    const withAudio = (durationSec: number) =>
      evaluateProbe(
        probe([
          goodVideo,
          {
            codec_type: "audio",
            codec_name: "aac",
            sample_rate: "48000",
            duration: String(durationSec),
          },
        ]),
        "mp4_720p",
        1_000_000,
        { expectAudio: true },
      );

    // 5.000s exactly, and 5.021s (one AAC frame long) both pass.
    expect(withAudio(5.0).ok).toBe(true);
    expect(withAudio(5.0 + 0.0213).ok).toBe(true);
    // Two frames is not rounding, it is the wrong length.
    expect(withAudio(5.0 + 0.0427).ok).toBe(false);
  });

  it("fails a silent profile that somehow carries a track", () => {
    const r = evaluateProbe(
      probe([goodVideo, { codec_type: "audio", codec_name: "aac", sample_rate: "48000" }]),
      "mp4_720p",
      1_000_000,
      { expectAudio: false },
    );
    // An unexpected audio track is how an ad ends up making noise over a stream.
    expect(r.problems.map((p) => p.check)).toContain("audio stream");
  });

  it("requires a finite VOD playlist with an init map", () => {
    const good = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:2",
      '#EXT-X-MAP:URI="720p-init.mp4"',
      "#EXTINF:2.000000,",
      "720p-0.m4s",
      "#EXTINF:2.000000,",
      "720p-1.m4s",
      "#EXTINF:1.000000,",
      "720p-2.m4s",
      "#EXT-X-ENDLIST",
    ].join("\n");
    expect(validateMediaPlaylist(good)).toEqual([]);

    // No ENDLIST => a player treats it as a live window and reloads forever.
    expect(validateMediaPlaylist(good.replace("#EXT-X-ENDLIST", ""))).not.toEqual([]);
    // No init map => the fMP4 segments cannot be decoded.
    expect(validateMediaPlaylist(good.replace(/#EXT-X-MAP[^\n]*\n/, ""))).not.toEqual([]);
  });

  it("catches a playlist whose segments do not add up to five seconds", () => {
    const short = [
      "#EXTM3U",
      '#EXT-X-MAP:URI="720p-init.mp4"',
      "#EXTINF:2.000000,",
      "720p-0.m4s",
      "#EXTINF:2.000000,",
      "720p-1.m4s",
      "#EXT-X-ENDLIST",
    ].join("\n");
    expect(validateMediaPlaylist(short).map((p) => p.check)).toContain("segment total duration");
  });
});

describe("a music bed under the narration", () => {
  const withBed = () =>
    mp4Args({
      framePattern: "/tmp/f-%04d.png",
      audioPath: "/tmp/narration.mp3",
      musicPath: "/tmp/bed.mp3",
      outPath: "/tmp/out.mp4",
      profile: "master_1080p",
      videoKbps: 4000,
    });

  it("loops the bed, since a bed is shorter than nothing in particular", () => {
    const a = withBed();
    // -stream_loop must precede the input it applies to.
    const loop = a.indexOf("-stream_loop");
    expect(loop).toBeGreaterThan(-1);
    expect(a[loop + 1]).toBe("-1");
    expect(a[loop + 3]).toBe("/tmp/bed.mp3");
  });

  it("holds the bed well under the voice", () => {
    const f = withBed().join(" ");
    // Broadcast practice is 15-20 dB down: felt, not competing with the read.
    expect(f).toContain("volume=-16dB");
  });

  it("fades the bed at both ends", () => {
    const f = withBed().join(" ");
    // On a five-second spot an abrupt bed is most of what you hear.
    expect(f).toContain("afade=t=in");
    expect(f).toContain("afade=t=out");
  });

  it("mixes without halving both sources", () => {
    // amix normalises by default, which would duck the voice as well.
    expect(withBed().join(" ")).toContain("normalize=0");
  });

  it("trims both to the length of the picture", () => {
    const f = withBed().join(" ");
    expect(f).toContain("atrim=0:5");
    expect(withBed()).toContain("-shortest");
  });

  it("a bed without a voice is ignored, since that is just music", () => {
    const a = mp4Args({
      framePattern: "/tmp/f-%04d.png",
      audioPath: null,
      musicPath: "/tmp/bed.mp3",
      outPath: "/tmp/out.mp4",
      profile: "master_1080p",
      videoKbps: 4000,
    });
    expect(a).toContain("-an");
    expect(a).not.toContain("-filter_complex");
  });

  it("no bed leaves the narrated path exactly as it was", () => {
    const a = mp4Args({
      framePattern: "/tmp/f-%04d.png",
      audioPath: "/tmp/narration.mp3",
      outPath: "/tmp/out.mp4",
      profile: "master_1080p",
      videoKbps: 4000,
    });
    expect(a).not.toContain("-filter_complex");
    expect(a[a.indexOf("-af") + 1]).toBe("apad");
  });
});
