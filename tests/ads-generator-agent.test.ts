import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The ad-generator-agent (lib/ads/agent.ts, c0mpute plugins/ad-generator-agent):
// every generated ad asset comes from c0mpute or from no model at all.

// Infernet is stubbed before backendAi builds its router, which captures fetch.
const calls: { url: string; body: Record<string, unknown> | null }[] = [];
const copy = {
  headline: "Audit every crawler",
  shortHeadline: "Audit crawlers",
  body: "See which bots read your site and what they cost you.",
  ctaText: "Try it free",
  bgColor: "#0b0d10",
  fgColor: "#e7e9ee",
  accentColor: "#6ee7b7",
  lightBgColor: "#f7f9fc",
  lightFgColor: "#0b0d10",
  lightAccentColor: "#0f766e",
  summaryShort: "CrawlProof shows site owners which crawlers read their pages.",
  summaryLong: "CrawlProof records crawler traffic per site.\n\nIt separates people from bots.",
};
vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  calls.push({ url: String(url), body });
  if (String(url).endsWith("/api/chat")) {
    expect(body?.p2p_only).toBe(true);
    return Response.json({ jobId: "adgen1", source: "p2p", model: body?.modelName });
  }
  if (String(url).includes("/api/chat/stream/adgen1")) {
    const text = JSON.stringify(copy).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const sse =
      'event: meta\ndata: {"model":"qwen-test"}\n\n' +
      `event: token\ndata: {"text":"${text}"}\n\n` +
      "event: done\ndata: {}\n\n";
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }
  throw new Error(`unexpected fetch ${url}`);
});

const hero = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/lib/ads/heroImage", () => ({ resolveAdHeroImage: hero.resolve }));
vi.mock("@/lib/ads/brand", async (original) => ({
  ...(await original<typeof import("@/lib/ads/brand")>()),
  extractSiteBrand: vi.fn(async () => ({
    url: "https://crawlproof.com/",
    domain: "crawlproof.com",
    title: "CrawlProof",
    description: "Crawler analytics",
    text: "CrawlProof shows which crawlers read your site. ".repeat(10),
    logoUrl: null,
    ogImage: null,
    themeColor: null,
    palette: ["#0b0d10"],
  })),
}));

// lib/env reads OPENAI_API_KEY once at import, so the paid client exists for
// the whole file: the tests prove the agent withholds it, not that it is absent.
process.env.OPENAI_API_KEY = "sk-test-not-used";
const agent = await import("@/lib/ads/agent");
const { generateAdCreatives } = await import("@/lib/ads/creative");
const { synthesiseNarration, NarrationError } = await import("@/lib/ads/video/narration");

const ENV_KEYS = [
  "AD_GENERATOR_AGENT",
  "AD_GENERATOR_PAID_IMAGES",
  "ELEVENLABS_API_KEY",
  "C0MPUTE_SPEECH_URL",
  "C0MPUTE_SPEECH_TOKEN",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.AD_GENERATOR_AGENT;
  delete process.env.AD_GENERATOR_PAID_IMAGES;
  calls.length = 0;
  hero.resolve.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("agent switches", () => {
  it("is on by default and off only when the operator says so", () => {
    expect(agent.adGeneratorAgentEnabled({})).toBe(true);
    for (const v of ["off", "0", "false", "no", "disabled"]) {
      expect(agent.adGeneratorAgentEnabled({ AD_GENERATOR_AGENT: v })).toBe(false);
    }
    expect(agent.adGeneratorAgentEnabled({ AD_GENERATOR_AGENT: "on" })).toBe(true);
  });

  it("keeps paid hero images off unless opted in", () => {
    expect(agent.paidHeroImagesAllowed({})).toBe(false);
    expect(agent.paidHeroImagesAllowed({ AD_GENERATOR_PAID_IMAGES: "1" })).toBe(true);
    expect(agent.paidHeroImagesAllowed({ AD_GENERATOR_AGENT: "off" })).toBe(true);
  });

  it("narrates on c0mpute while on, ElevenLabs only when off", () => {
    expect(agent.narrationRoute({})).toBe("c0mpute");
    expect(agent.narrationRoute({ AD_GENERATOR_AGENT: "off" })).toBe("elevenlabs");
  });

  it("prefers a private speech gateway and falls back to Infernet's voice route", () => {
    expect(
      agent.c0mputeSpeechTarget({ C0MPUTE_SPEECH_URL: "http://gw:8787/", C0MPUTE_SPEECH_TOKEN: "t" }),
    ).toEqual({ url: "http://gw:8787/v1/tts", token: "t" });
    expect(agent.c0mputeSpeechTarget({})).toEqual({
      url: "https://infernetprotocol.com/api/chat/voice/tts",
      token: null,
    });
  });
});

describe("copy and artwork", () => {
  it("writes the copy on c0mpute and never asks gpt-image for a hero", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-used";
    const out = await generateAdCreatives("https://crawlproof.com", { supabase: {} as never });

    expect(out.provider).toBe("ad-generator-agent/c0mpute");
    expect(out.creatives.length).toBeGreaterThan(0);
    expect(out.creatives[0].headline).toBe("Audit every crawler");
    // The Infernet call is the only network call, and it is p2p_only.
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/chat",
      "/api/chat/stream/adgen1",
    ]);
    expect(hero.resolve).toHaveBeenCalledTimes(1);
    expect(hero.resolve.mock.calls[0][0].openai).toBeNull();
  });

  it("hands the hero step the paid client only with the opt-in", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-used";
    process.env.AD_GENERATOR_PAID_IMAGES = "1";
    await generateAdCreatives("https://crawlproof.com", { supabase: {} as never });
    expect(hero.resolve.mock.calls[0][0].openai).not.toBeNull();
  });
});

describe("narration on c0mpute", () => {
  const snapshot = {
    audioMode: "narrated",
    headline: "Audit every crawler",
    ctaText: "Try it free",
    domain: "crawlproof.com",
  } as never;
  const wav = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WAVEfmt "),
    Buffer.alloc(64, 1),
  ]);

  it("buys one tts.synthesize job and writes the WAV it returns", async () => {
    process.env.ELEVENLABS_API_KEY = "paid-key-must-not-be-used";
    const dir = await mkdtemp(path.join(tmpdir(), "adgen-narr-"));
    const seen: { url: string; init: RequestInit }[] = [];
    try {
      const res = await synthesiseNarration({
        snapshot,
        workDir: dir,
        speech: { url: "http://gw:8787/v1/tts", token: "gw-token" },
        fetchImpl: (async (url: string, init: RequestInit) => {
          seen.push({ url, init });
          return new Response(wav, { headers: { "content-type": "audio/wav" } });
        }) as typeof fetch,
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe("http://gw:8787/v1/tts");
      expect((seen[0].init.headers as Record<string, string>).authorization).toBe("Bearer gw-token");
      const body = JSON.parse(String(seen[0].init.body));
      expect(body).toMatchObject({ engine: "kokoro", voice: "af_sarah", locale: "en-US", speed: 1 });
      expect(body.text).toBe("Audit every crawler. Try it free at crawl proof dot com.");
      expect(res!.filePath.endsWith("narration.wav")).toBe(true);
      expect((await readFile(res!.filePath)).equals(wav)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries when no c0mpute worker took the job, instead of paying for a voice", async () => {
    process.env.ELEVENLABS_API_KEY = "paid-key-must-not-be-used";
    const urls: string[] = [];
    const run = synthesiseNarration({
      snapshot,
      workDir: "/unused",
      speech: { url: "http://gw/v1/tts", token: null },
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return Response.json({ error: "no c0mpute worker completed the speech job" }, { status: 503 });
      }) as typeof fetch,
    });
    await expect(run).rejects.toMatchObject({ code: "narration_no_c0mpute_worker", retryable: true });
    expect(urls).toEqual(["http://gw/v1/tts"]);
  });

  it("does not retry a rejected request or bad credentials", async () => {
    for (const status of [400, 401]) {
      const run = synthesiseNarration({
        snapshot,
        workDir: "/unused",
        speech: { url: "http://gw/v1/tts", token: "t" },
        fetchImpl: (async () => new Response("no", { status })) as typeof fetch,
      });
      await expect(run).rejects.toBeInstanceOf(NarrationError);
      await expect(run).rejects.toMatchObject({ retryable: false });
    }
  });

  it("refuses a body that is not audio", async () => {
    const run = synthesiseNarration({
      snapshot,
      workDir: "/unused",
      speech: { url: "http://gw/v1/tts", token: null },
      fetchImpl: (async () => new Response("<html>oops</html>".repeat(10))) as typeof fetch,
    });
    await expect(run).rejects.toMatchObject({ code: "narration_bad_audio", retryable: true });
  });
});
