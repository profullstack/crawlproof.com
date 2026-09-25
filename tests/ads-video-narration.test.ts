import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_NARRATION_CHARS,
  narrationScript,
  narrationVariants,
  synthesiseNarration,
} from "@/lib/ads/video/narration";
import type { VideoDesignSnapshot } from "@/lib/ads/video/snapshot";

const snapshot = (over: Partial<VideoDesignSnapshot> = {}): VideoDesignSnapshot => ({
  headline: "All fixtures, one feed",
  subhead: "Every source in one place",
  ctaText: "View feeds",
  domain: "nichedb.dev",
  bgColor: "#12161f",
  fgColor: "#e7e9ee",
  accentColor: "#6ee7b7",
  fontFamily: "system-ui, sans-serif",
  logoUrl: null,
  logoSha256: null,
  heroUrl: null,
  heroSha256: null,
  audioMode: "narrated",
  narration: null,
  locale: "en",
  reducedMotion: false,
  ...over,
});

describe("the script is the approved copy, spoken", () => {
  it("says the headline, then the call to action and the domain", () => {
    // Derived, never written afresh: an ad whose voiceover claims something its
    // banner does not is a compliance problem, not a stylistic one.
    expect(narrationScript(snapshot())).toBe(
      "All fixtures, one feed. View feeds at nichedb.dev.",
    );
  });

  it("does not double the full stop on a headline that has one", () => {
    expect(narrationScript(snapshot({ headline: "Sources in, feeds out!" }))).toBe(
      "Sources in, feeds out! View feeds at nichedb.dev.",
    );
  });

  it("is deterministic, because it is part of the render hash", () => {
    expect(narrationScript(snapshot())).toBe(narrationScript(snapshot()));
  });

  it("shortens a long line to a clause, never to a fragment", () => {
    const long = narrationScript(
      snapshot({ headline: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen" }),
    );
    expect(long.length).toBeLessThanOrEqual(MAX_NARRATION_CHARS + 1);
    // A voice cut off mid-word is worse than a shorter line.
    expect(long).not.toMatch(/\s\w{1,2}\.$/);
    expect(long.endsWith(".")).toBe(true);
    expect(long).toContain("nichedb.dev");
  });

  it("keeps the address when the address alone is over the estimate", () => {
    // A 62-character .onion domain puts every candidate over the cap. Clipping
    // the fullest line — the first thing this did — produced "Open this .onion
    // address. Open in Tor at.", an advert that names nothing, because
    // trimming from the end removes the destination first.
    const onion = "7btj5kisrpopxjkhmcugbiygfk2xd6op3ta7whfrmxxrldyrlh5b5zad.onion";
    const line = narrationScript(
      snapshot({ headline: "Open this .onion address", ctaText: "Open in Tor", domain: onion }),
    );
    expect(line).toContain(onion);
    // Over the estimate on purpose: the estimate only picks a candidate, and
    // the fit compresses whatever comes back into the spot.
    expect(line).toBe(`${onion}.`);
  });

  it("drops a whole clause rather than words off the end", () => {
    // The destination is last because it is what a listener is meant to leave
    // with, so shortening from the end — which is what a character cap does,
    // and what the encoder was doing to the finished audio — drops exactly the
    // wrong words. Every step of the ladder keeps the domain.
    const long = narrationScript(
      snapshot({ headline: "Independent podcasts, every one of them self-hosted" }),
    );
    expect(long).toContain("nichedb.dev");
    expect(long.endsWith("nichedb.dev.")).toBe(true);
  });

  it("keeps the read inside what five seconds can hold", () => {
    // 140 characters is about nine seconds of speech, which is where the
    // truncated ads came from: the spot is five seconds and it wins.
    expect(MAX_NARRATION_CHARS).toBeLessThan(70);
    for (const line of narrationVariants(snapshot())) {
      expect(line.endsWith("nichedb.dev.")).toBe(true);
    }
  });

  it("collapses whitespace so the read is not shaped by the authoring", () => {
    expect(narrationScript(snapshot({ headline: "All   fixtures,\n one feed" }))).toContain(
      "All fixtures, one feed",
    );
  });
});

describe("synthesis never fails a render", () => {
  it("returns null with no API key", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "narr-"));
    try {
      expect(await synthesiseNarration({ snapshot: snapshot(), workDir: dir, apiKey: null })).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null on a non-200, rather than throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "narr-"));
    try {
      const res = await synthesiseNarration({
        snapshot: snapshot(),
        workDir: dir,
        apiKey: "k",
        fetchImpl: (async () => new Response("rate limited", { status: 429 })) as typeof fetch,
      });
      expect(res).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null on a 200 with an empty body", async () => {
    // A success code with no bytes is a failure wearing a success code, and
    // muxing zero bytes fails much later with a worse message.
    const dir = await mkdtemp(path.join(tmpdir(), "narr-"));
    try {
      const res = await synthesiseNarration({
        snapshot: snapshot(),
        workDir: dir,
        apiKey: "k",
        fetchImpl: (async () => new Response(new ArrayBuffer(0), { status: 200 })) as typeof fetch,
      });
      expect(res).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the network throws", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "narr-"));
    try {
      const res = await synthesiseNarration({
        snapshot: snapshot(),
        workDir: dir,
        apiKey: "k",
        fetchImpl: (async () => {
          throw new Error("ECONNRESET");
        }) as typeof fetch,
      });
      expect(res).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes the audio and reports the script it spoke", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "narr-"));
    try {
      const bytes = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]);
      const res = await synthesiseNarration({
        snapshot: snapshot(),
        workDir: dir,
        apiKey: "k",
        fetchImpl: (async () => new Response(bytes, { status: 200 })) as typeof fetch,
      });
      expect(res).not.toBeNull();
      expect(res!.script).toBe("All fixtures, one feed. View feeds at nichedb.dev.");
      expect((await stat(res!.filePath)).size).toBe(bytes.byteLength);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
