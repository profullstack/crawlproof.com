// Platform-aware LLM rendering for social autoposts. One Claude Haiku
// call per (item, platform) returns post text + hashtags tailored to
// the platform's idioms, the project's brand voice, and any custom
// instructions. Results are cached on sp_feed_item.rendered_per_platform
// so we never re-render the same item for the same platform.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
// SDK zod helpers require v4 (z.toJSONSchema). See lib/lx/detectBlog.ts.
import { z } from "zod/v4";
import { generateStructuredOutput } from "@/lib/lx/backendAi";
import { env } from "@/lib/env";

const RENDER_MODEL = "claude-haiku-4-5-20251001";

const RenderSchema = z.object({
  text: z
    .string()
    .describe("The post body — WITHOUT the article URL and WITHOUT hashtags."),
  title: z
    .string()
    .describe("Reddit post title; empty string for every other platform."),
  hashtags: z
    .array(z.string())
    .describe("Platform-appropriate hashtags (no leading #). Empty if the platform doesn't use them."),
});

export type RenderedPost = {
  // Post body text; assembled with url + hashtags by the caller.
  text: string;
  // Optional Reddit title — only set when platform === 'reddit'.
  title?: string;
  // Platform-appropriate hashtags (empty for platforms that don't use them).
  hashtags: string[];
};

export type ProjectSocialConfig = {
  brand_voice: string;
  tone: string;
  default_hashtags: string[];
  custom_instructions: string;
};

type PlatformProfile = {
  // Soft cap fed to the model; hard truncation happens later if it
  // overflows. The LLM is told the limit so it doesn't blow past.
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
      "Sharp, scroll-stopping. Front-load the value. Hashtags only if they add reach, not decoration.",
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
      "1-3 short paragraphs. Lead with the insight, not the brag. End with 3-5 relevant hashtags. Avoid corporate platitudes.",
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
};

const HASHTAG_GUIDANCE: Record<PlatformProfile["usesHashtags"], string> = {
  many: "Include 3-5 hashtags.",
  few: "Include 1-3 hashtags if they actually add discovery; otherwise none.",
  rare: "Hashtags only if extremely relevant (0-1).",
  none: "Do not include hashtags.",
};

const SYSTEM_PROMPT = `You write social posts for a small SaaS product. You write the way a sharp human operator writes — never the way an LLM writes. Avoid: "In today's digital landscape", "unlock", "leverage", "synergy", "game-changer", "delve", "navigate", em-dashes used as breath marks, every sentence starting with the same structure. Use: real specifics from the article, concrete claims, a clear hook. If you don't have a real reason to add a sentence, don't add it.`;

// Renders brand-aware, per-platform post copy. Throws when no real copy can
// be produced (no provider, unknown platform, model error/empty output) so the
// caller can mark the item failed/retryable — we never emit raw "title\nurl"
// spam.
export async function renderPostForPlatform(args: {
  anthropic: Anthropic | null;
  openai: OpenAI | null;
  platform: string;
  url: string;
  articleTitle: string | null;
  config: ProjectSocialConfig;
}): Promise<RenderedPost> {
  const { anthropic, openai, platform, url, articleTitle, config } = args;
  const profile = PLATFORM_PROFILES[platform];
  if (!profile) {
    throw new Error(`No platform profile configured for "${platform}".`);
  }
  if (!anthropic && !openai) {
    throw new Error("No AI provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY).");
  }

  const tone = config.tone || "casual";
  const brandVoice =
    config.brand_voice.trim() || "Unspecified — write neutrally.";
  const defaults =
    config.default_hashtags.length > 0
      ? `Include these hashtags if they fit the platform: ${config.default_hashtags.join(", ")}.`
      : "";
  const custom = config.custom_instructions.trim()
    ? `Additional brand rules: ${config.custom_instructions.trim()}`
    : "";

  const userPrompt = [
    `Platform: ${platform}.`,
    `Soft char limit: ${profile.maxChars}.`,
    `Platform voice: ${profile.voice}`,
    `${HASHTAG_GUIDANCE[profile.usesHashtags]}`,
    `Tone: ${tone}.`,
    `Brand voice: ${brandVoice}`,
    defaults,
    custom,
    `Article title: ${articleTitle ?? "(no title — derive from URL)"}`,
    `Article URL (do NOT include in the text field; the renderer appends it): ${url}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { output } = await generateStructuredOutput({
    name: "sp_render_post",
    schema: RenderSchema,
    system: SYSTEM_PROMPT,
    user: userPrompt,
    anthropic,
    openai,
    preference: env.backendAiProvider,
    anthropicModel: RENDER_MODEL,
    openaiModel: env.backendAiOpenaiModel,
    maxTokens: 800,
    // Haiku 4.5 rejects Anthropic's `effort` parameter.
    anthropicEffort: false,
  });

  const text = (output.text ?? "").trim();
  if (!text) {
    throw new Error("Render produced empty text.");
  }
  const title =
    platform === "reddit" && output.title?.trim() ? output.title.trim() : undefined;
  const hashtags = (output.hashtags ?? [])
    .filter((h): h is string => typeof h === "string")
    .map((h) => (h.startsWith("#") ? h : `#${h}`))
    .slice(0, 8);

  return { text, title, hashtags };
}

// Assemble final post text for the platform from the rendered pieces +
// the article URL. Different platforms want different orderings; some
// embed the URL inline, others trail it after a blank line.
export function assemblePostText(args: {
  rendered: RenderedPost;
  url: string;
  platform: string;
}): string {
  const { rendered, url, platform } = args;
  const profile = PLATFORM_PROFILES[platform];
  const tagsBlock = rendered.hashtags.length > 0 ? rendered.hashtags.join(" ") : "";

  if (platform === "reddit") {
    // Reddit's "text" body is its self-post; URL goes in the body. Title
    // is handled at the postViaAccount layer.
    return [rendered.text, url].filter(Boolean).join("\n\n");
  }
  if (platform === "linkedin") {
    return [rendered.text, url, tagsBlock].filter(Boolean).join("\n\n");
  }
  if (platform === "discord" || platform === "telegram") {
    // No hashtags for these.
    return [rendered.text, url].filter(Boolean).join("\n\n");
  }
  // Default short-form (bluesky/x/threads/mastodon/facebook): inline.
  const head =
    profile && rendered.text.length + url.length + 2 > profile.maxChars
      ? rendered.text.slice(0, Math.max(0, profile.maxChars - url.length - 8)) + "…"
      : rendered.text;
  return [head, url, tagsBlock].filter(Boolean).join("\n");
}

