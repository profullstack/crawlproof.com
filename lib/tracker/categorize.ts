// Categorize an incoming tracker event into a "bucket" string we count in
// tracker_daily_stats. Buckets stay readable so the dashboard can display
// them directly: 'ai_referral:chatgpt', 'bot:gptbot', 'search:google',
// 'social:twitter', 'human:direct'.

interface CategorizeInput {
  referrer: string | null;
  userAgent: string | null;
  /**
   * The page the hit landed on, query string included. A visit that arrived
   * through an ad announces itself there, not in the referrer: our click
   * redirect appends `?ref=crawlproof-ad-NNN`, and paid links elsewhere carry
   * utm_medium=cpc and friends.
   */
  url?: string | null;
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

const HEADLESS_ENGINES =
  /lightpanda|phantomjs|slimerjs|htmlunit|puppeteer|playwright|selenium|webdriver|cypress|python-requests|python-urllib|aiohttp|httpx|go-http-client|node-fetch|undici|axios\/|okhttp|java\/|libwww-perl|^curl\/|^wget\//i;

const DAY_MS = 86_400_000;
const FOUR_WEEKS_MS = 28 * DAY_MS;
/** Both browsers ship a major every four weeks. Anchors: Chrome 120 on 2023-12-05, Firefox 121 on 2023-12-19. */
const CHROME_ANCHOR = { major: 120, at: Date.UTC(2023, 11, 5) };
const FIREFOX_ANCHOR = { major: 121, at: Date.UTC(2023, 11, 19) };
/**
 * How far behind the expected current major a browser may be before it is
 * called stale: 26 releases, about two years. The estimate runs a few majors
 * ahead of reality (holiday gaps), which only makes the floor more lenient.
 */
const STALE_MAJORS = 26;

function staleFloor(anchor: { major: number; at: number }, now: number): number {
  return anchor.major + Math.floor((now - anchor.at) / FOUR_WEEKS_MS) - STALE_MAJORS;
}

/** True for a Chrome/Chromium/Edge or Firefox UA about two years out of date, or a quote-wrapped UA. */
export function isStaleBrowser(ua: string, now: number = Date.now()): boolean {
  if (/^["']/.test(ua)) return true;
  const chrome = /(?:Chrome|Chromium|CriOS)\/(\d+)\./.exec(ua);
  if (chrome) return Number(chrome[1]) < staleFloor(CHROME_ANCHOR, now);
  const firefox = /(?:Firefox|FxiOS)\/(\d+)\./.exec(ua);
  if (firefox) return Number(firefox[1]) < staleFloor(FIREFOX_ANCHOR, now);
  return false;
}

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

/** utm_medium values that mean "somebody paid for this click". */
const PAID_MEDIUMS = new Set(["cpc", "ppc", "cpm", "paid", "paidsocial", "paid_social", "display", "ad", "ads", "banner", "sponsored"]);

/** A CrawlProof campaign ref, as appendRef() writes it onto the destination. */
const CRAWLPROOF_REF = /^crawlproof-ad-\d+$/;

/**
 * The ad this hit came from, if it came from one. `ad:crawlproof-ad-072` for
 * our own campaigns — the value is the campaign's ref slug, so a campaign's
 * visits can be counted on the site it points at — and `ad:<utm_source>` for
 * paid links tagged the conventional way.
 */
export function adFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let params: URLSearchParams;
  try {
    params = new URL(url, "https://placeholder.invalid").searchParams;
  } catch {
    return null;
  }
  const ref = params.get("ref")?.trim().toLowerCase() ?? "";
  if (CRAWLPROOF_REF.test(ref)) return ref;

  const medium = params.get("utm_medium")?.trim().toLowerCase() ?? "";
  if (PAID_MEDIUMS.has(medium)) {
    const source = (params.get("utm_source") ?? "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").slice(0, 40);
    return source || "unknown";
  }
  if (params.has("gclid")) return "google";
  if (params.has("msclkid")) return "bing";
  return null;
}

export function categorize({
  referrer,
  userAgent,
  url,
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

  // Headless engines and automation stacks that name themselves without
  // saying "headless". Lightpanda/1.0 alone was 9,680 "human" page views on
  // rssamplifier.com in one day (2026-10-17).
  if (HEADLESS_ENGINES.test(ua)) {
    return { bucket: "bot:headless", isAi: false };
  }

  // A browser that executes our script but claims a version years out of
  // date, or a UA that arrives still wrapped in quotes, is a scraper reading
  // from a stale UA list. Chrome and Firefox auto-update; nobody browses on a
  // two-year-old one. 88% of watchnews.now's "humans" were Chrome 119/120 and
  // Firefox 120/121 in October 2026.
  if (isStaleBrowser(ua)) {
    return { bucket: "bot:stale_ua", isAi: false };
  }

  // An ad click beats the referrer: the referrer of a paid visit is whatever
  // page carried the unit, which says where the ad ran, not why they came.
  const ad = adFromUrl(url);
  if (ad) return { bucket: `ad:${ad}`, isAi: false };

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
    case "ad":
      return `Ad · ${value}`;
    case "human":
      return value === "direct" ? "Direct" : value;
    default:
      return bucket;
  }
}
