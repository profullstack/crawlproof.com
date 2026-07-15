// Dual-provider (Anthropic + OpenAI) copywriter for the Promote feature.
// Every call produces a fresh, unique marketing pitch for a given link × platform
// combination. Reuses the structured-output helper from lib/lx/backendAi.ts.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod/v4";
import { generateStructuredOutput } from "@/lib/lx/backendAi";
import { env } from "@/lib/env";

const RENDER_MODEL = "claude-haiku-4-5-20251001";

const PitchSchema = z.object({
  text: z
    .string()
    .describe(
      "The post body — a marketing pitch for the link. Do NOT include the URL itself; the caller appends it.",
    ),
  title: z
    .string()
    .describe("Reddit post title; empty string for every other platform."),
  hashtags: z
    .array(z.string())
    .describe(
      "Platform-appropriate hashtags (no leading #). Empty if the platform doesn't use them.",
    ),
});

type PlatformProfile = {
  maxChars: number;
  usesHashtags: "many" | "few" | "rare" | "none";
  voice: string;
};

const PLATFORM_PROFILES: Record<string, PlatformProfile> = {
  bluesky: {
    maxChars: 280,
    usesHashtags: "few",
    voice:
      "Tight, punchy hook. One sentence or two at most. Conversational, no LinkedIn-speak.",
  },
  x: {
    maxChars: 260,
    usesHashtags: "few",
    voice:
      "Sharp, scroll-stopping. Front-load the value. Hashtags only if they add reach.",
  },
  threads: {
    maxChars: 480,
    usesHashtags: "few",
    voice: "Conversational. One short hook, then one supporting line if needed.",
  },
  mastodon: {
    maxChars: 480,
    usesHashtags: "few",
    voice:
      "Slightly longer than Bluesky. Plain, informative, no marketing fluff. 2-3 hashtags are idiomatic.",
  },
  linkedin: {
    maxChars: 1500,
    usesHashtags: "many",
    voice:
      "1-3 short paragraphs. Lead with the insight, not the brag. End with 3-5 relevant hashtags.",
  },
  facebook: {
    maxChars: 600,
    usesHashtags: "rare",
    voice: "Friendly, accessible. Plain language. Hashtags rarely.",
  },
  facebook_page: {
    maxChars: 600,
    usesHashtags: "rare",
    voice: "Friendly, accessible. Plain language. Hashtags rarely.",
  },
  discord: {
    maxChars: 1800,
    usesHashtags: "none",
    voice:
      "Casual, peer-to-peer. Like sharing a link in a team chat. No hashtags.",
  },
  telegram: {
    maxChars: 800,
    usesHashtags: "none",
    voice: "Brief, headline-style. No hashtags.",
  },
  reddit: {
    maxChars: 800,
    usesHashtags: "none",
    voice:
      "Title is a question or claim that earns the click without clickbait. Body is plain prose, no hashtags, no emojis.",
  },
  instagram: {
    maxChars: 1800,
    usesHashtags: "many",
    voice:
      "Visual-first caption. Lead with one punchy hook sentence, add 2-3 lines of context, close with 5-10 relevant hashtags.",
  },
};

const HASHTAG_GUIDANCE: Record<PlatformProfile["usesHashtags"], string> = {
  many: "Include 3-5 hashtags.",
  few: "Include 1-3 hashtags if they actually add discovery; otherwise none.",
  rare: "Hashtags only if extremely relevant (0-1).",
  none: "Do not include hashtags.",
};

const SYSTEM_PROMPT = `You write marketing pitches for social media. You write the way a sharp growth marketer writes — never the way an LLM writes. Every pitch must be unique and fresh. Avoid: "In today's digital landscape", "unlock", "leverage", "synergy", "game-changer", "delve", "navigate", em-dashes used as breath marks, every sentence starting with the same structure. Use: real specifics from the page, concrete benefits, a clear hook. If you don't have a real reason to add a sentence, don't add it. The pitch should make someone want to click the link.`;

export type GeneratePitchArgs = {
  url: string;
  title: string | null;
  angle: string | null;
  platform: string;
  brandVoice: string | null;
  recentBodies: string[];
  anthropic: Anthropic | null;
  openai: OpenAI | null;
};

export type PitchResult = {
  body: string;
  title?: string;
  hashtags: string[];
  provider: string;
  model: string;
};

export async function generatePitch(
  args: GeneratePitchArgs,
): Promise<PitchResult> {
  const {
    url,
    title,
    angle,
    platform,
    brandVoice,
    recentBodies,
    anthropic,
    openai,
  } = args;

  if (!anthropic && !openai) {
    throw new Error(
      "No AI provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY).",
    );
  }

  const profile = PLATFORM_PROFILES[platform] ?? PLATFORM_PROFILES["threads"];

  const avoidSection =
    recentBodies.length > 0
      ? `\n\nAvoid repeating these recent pitches for this link on this platform (write something with a DIFFERENT angle, hook, and structure):\n${recentBodies
          .slice(0, 5)
          .map((b, i) => `--- Previous pitch ${i + 1} ---\n${b}`)
          .join("\n\n")}`
      : "";

  const userPrompt = [
    `Platform: ${platform}.`,
    `Soft char limit: ${profile.maxChars}.`,
    `Platform voice: ${profile.voice}`,
    `${HASHTAG_GUIDANCE[profile.usesHashtags]}`,
    brandVoice ? `Brand voice / instructions: ${brandVoice}` : "",
    angle ? `Marketing angle to emphasize: ${angle}` : "",
    `Page title: ${title ?? "(no title — derive from URL)"}`,
    `URL to promote (do NOT include in the text field; the renderer appends it): ${url}`,
    avoidSection,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { output, provider: usedProvider } = await generateStructuredOutput({
    name: "promote_pitch",
    schema: PitchSchema,
    system: SYSTEM_PROMPT,
    user: userPrompt,
    anthropic,
    openai,
    preference: env.backendAiProvider,
    anthropicModel: RENDER_MODEL,
    openaiModel: env.backendAiOpenaiModel,
    maxTokens: 800,
    anthropicEffort: false,
  });

  const text = (output.text ?? "").trim();
  if (!text) {
    throw new Error("Pitch generation produced empty text.");
  }

  const postTitle =
    platform === "reddit" && output.title?.trim()
      ? output.title.trim()
      : undefined;

  const hashtags = (output.hashtags ?? [])
    .filter((h): h is string => typeof h === "string")
    .map((h) => (h.startsWith("#") ? h : `#${h}`))
    .slice(0, 8);

  // Assemble final body: text + hashtags + url
  const tagsBlock = hashtags.length > 0 ? hashtags.join(" ") : "";
  const parts = [text, url, tagsBlock].filter(Boolean);
  const joiner = platform === "linkedin" || platform === "discord" || platform === "telegram" ? "\n\n" : "\n";
  const body = parts.join(joiner);

  return {
    body,
    title: postTitle,
    hashtags,
    provider: usedProvider,
    model: usedProvider === "anthropic" ? RENDER_MODEL : (env.backendAiOpenaiModel ?? "gpt-4o-mini"),
  };
}

// ---------- Link helpers ----------

/** Parse a raw textarea value into deduplicated, validated URLs. */
export function parseLinks(raw: string): string[] {
  const urls = raw
    .split(/[\n,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\/.+/i.test(s));
  return [...new Set(urls)];
}

/** Best-effort fetch of <title> / og:title for a URL. */
export async function fetchLinkTitle(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "CrawlProofPromote/1.0" },
      signal: AbortSignal.timeout(8_000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Try og:title first
    const ogMatch = html.match(/<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i);
    if (ogMatch?.[1]) return ogMatch[1].slice(0, 200);
    // Fall back to <title>
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch?.[1]) return titleMatch[1].trim().slice(0, 200);
    return null;
  } catch {
    return null;
  }
}

// ---------- Cadence presets ----------

export const CADENCE_PRESETS = [
  { label: "Every 15 min", seconds: 900 },
  { label: "Every 30 min", seconds: 1800 },
  { label: "Every hour", seconds: 3600 },
  { label: "Every 3 hours", seconds: 10800 },
  { label: "Every 6 hours", seconds: 21600 },
  { label: "Daily", seconds: 86400 },
] as const;

export function cadenceLabel(seconds: number): string {
  const preset = CADENCE_PRESETS.find((p) => p.seconds === seconds);
  if (preset) return preset.label;
  if (seconds < 3600) return `Every ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `Every ${Math.round(seconds / 3600)} hours`;
  return `Every ${Math.round(seconds / 86400)} days`;
}
