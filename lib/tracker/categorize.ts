// Categorize an incoming tracker event into a "bucket" string we count in
// tracker_daily_stats. Buckets stay readable so the dashboard can display
// them directly: 'ai_referral:chatgpt', 'bot:gptbot', 'search:google',
// 'social:twitter', 'human:direct'.

interface CategorizeInput {
  referrer: string | null;
  userAgent: string | null;
}

interface CategorizeResult {
  bucket: string;
  isAi: boolean;
}

// Host suffix → bucket. Host is matched against the rightmost portion so
// www.<host> and chat.<host> both hit. Order matters only inside a group;
// the first matching group wins.
const AI_REFERRERS: Record<string, string> = {
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  "openai.com": "chatgpt",
  "perplexity.ai": "perplexity",
  "claude.ai": "claude",
  "anthropic.com": "claude",
  "gemini.google.com": "gemini",
  "bard.google.com": "gemini",
  "copilot.microsoft.com": "copilot",
  "you.com": "you",
  "phind.com": "phind",
  "kagi.com": "kagi",
  "duckduckgo.com": "duckduckgo_ai",
};

const SEARCH_REFERRERS: Record<string, string> = {
  "google.com": "google",
  "bing.com": "bing",
  "yahoo.com": "yahoo",
  "yandex.com": "yandex",
  "baidu.com": "baidu",
  "ecosia.org": "ecosia",
  "brave.com": "brave",
};

const SOCIAL_REFERRERS: Record<string, string> = {
  "twitter.com": "twitter",
  "x.com": "twitter",
  "t.co": "twitter",
  "facebook.com": "facebook",
  "linkedin.com": "linkedin",
  "lnkd.in": "linkedin",
  "reddit.com": "reddit",
  "news.ycombinator.com": "hackernews",
  "youtube.com": "youtube",
  "github.com": "github",
  "discord.com": "discord",
  "t.me": "telegram",
};

// Substring match on user-agent (case-insensitive). Returned bucket name
// is the key in lowercase. Add new bots as they appear on the public list.
const AI_BOTS: Record<string, string> = {
  GPTBot: "gptbot",
  "OAI-SearchBot": "oai_searchbot",
  ChatGPT: "chatgpt_user",
  ClaudeBot: "claudebot",
  "Claude-Web": "claude_web",
  PerplexityBot: "perplexitybot",
  "Perplexity-User": "perplexity_user",
  "Google-Extended": "google_extended",
  Googlebot: "googlebot",
  Bingbot: "bingbot",
  "Amazonbot": "amazonbot",
  "Applebot-Extended": "applebot_extended",
  Applebot: "applebot",
  YandexBot: "yandexbot",
  Bytespider: "bytespider",
  CCBot: "ccbot",
  cohere: "cohere",
  Meta: "meta_external",
  "facebookexternalhit": "facebook_bot",
  Twitterbot: "twitterbot",
};

const AI_BOT_NAMES = new Set([
  "gptbot",
  "oai_searchbot",
  "chatgpt_user",
  "claudebot",
  "claude_web",
  "perplexitybot",
  "perplexity_user",
  "google_extended",
  "applebot_extended",
  "bytespider",
  "ccbot",
  "cohere",
  "meta_external",
]);

function hostnameFromReferrer(ref: string | null): string | null {
  if (!ref) return null;
  try {
    const url = new URL(ref);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function matchHost(
  host: string,
  table: Record<string, string>,
): string | null {
  if (table[host]) return table[host];
  // Suffix match: chat.openai.com matches openai.com
  for (const key of Object.keys(table)) {
    if (host.endsWith("." + key)) return table[key];
  }
  return null;
}

export function categorize({
  referrer,
  userAgent,
}: CategorizeInput): CategorizeResult {
  const ua = userAgent || "";

  // Bot detection first — a request with a bot UA is a crawler hit even if
  // it happens to carry a referrer.
  for (const [needle, name] of Object.entries(AI_BOTS)) {
    if (ua.toLowerCase().includes(needle.toLowerCase())) {
      return {
        bucket: `bot:${name}`,
        isAi: AI_BOT_NAMES.has(name),
      };
    }
  }

  // Generic "bot" catch-all so we don't count headless / scraper traffic
  // as human pageviews. AI bots are matched above, so this is non-AI bots.
  if (/bot\b|crawler|spider|scraper|headless/i.test(ua)) {
    return { bucket: "bot:other", isAi: false };
  }

  const host = hostnameFromReferrer(referrer);

  if (host) {
    const ai = matchHost(host, AI_REFERRERS);
    if (ai) return { bucket: `ai_referral:${ai}`, isAi: true };

    const search = matchHost(host, SEARCH_REFERRERS);
    if (search) return { bucket: `search:${search}`, isAi: false };

    const social = matchHost(host, SOCIAL_REFERRERS);
    if (social) return { bucket: `social:${social}`, isAi: false };

    return { bucket: `referral:${host}`, isAi: false };
  }

  return { bucket: "human:direct", isAi: false };
}

/** Human-readable label for a bucket string, for the dashboard table. */
export function bucketLabel(bucket: string): string {
  const [group, value] = bucket.split(":", 2);
  switch (group) {
    case "ai_referral":
      return `AI · ${value}`;
    case "bot":
      return `Bot · ${value}`;
    case "search":
      return `Search · ${value}`;
    case "social":
      return `Social · ${value}`;
    case "referral":
      return `Referral · ${value}`;
    case "human":
      return value === "direct" ? "Direct" : value;
    default:
      return bucket;
  }
}
