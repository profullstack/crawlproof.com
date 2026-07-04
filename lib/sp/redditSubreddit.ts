// Pick a fallback subreddit for a Reddit post that didn't specify one.
//
// Reddit posting is cookie/browser-based, and outreach (and some autoposts)
// don't carry a subreddit — which used to fail the post outright with
// "Subreddit is required for Reddit posts." Instead we route the post to a
// relatively open ("low moderation") subreddit that fits the content, so it
// actually goes out rather than erroring.
//
// This is a best-effort curated list — moderation strictness changes over time
// and can't be verified from here — so it's overridable with
// SP_REDDIT_DEFAULT_SUBS (comma-separated, most-preferred first). Keyword
// routing picks the most topically-relevant entry for the post text; when
// nothing matches (or an env override is set) it falls back to the first entry.

type Curated = { sub: string; keywords: string[] };

// Ordered by fallback preference. r/SideProject is broadly open to sharing a
// tool/site; the others catch SEO / blogging / AI-search themed posts.
const CURATED: Curated[] = [
  {
    sub: "SideProject",
    keywords: ["launch", "built", "made", "project", "tool", "app", "startup", "saas"],
  },
  {
    sub: "juststart",
    keywords: ["blog", "traffic", "website", "site", "content", "affiliate", "niche"],
  },
  {
    sub: "SEO",
    keywords: ["seo", "search", "rank", "ranking", "google", "serp", "backlink", "keyword", "crawl"],
  },
  {
    sub: "artificial",
    keywords: ["ai", "llm", "chatgpt", "gpt", "claude", "gemini", "perplexity", "aeo", "answer engine"],
  },
];

function normalizeSub(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^\/?r\//i, "").trim();
}

function envSubs(): string[] {
  return (process.env.SP_REDDIT_DEFAULT_SUBS ?? "")
    .split(",")
    .map((s) => normalizeSub(s))
    .filter(Boolean);
}

// Choose a subreddit for the given post content. Prefers an env-configured
// list; otherwise keyword-routes over the curated list. Always returns a
// non-empty subreddit name (no leading "r/").
export function pickDefaultSubreddit(content: string | null | undefined): string {
  const overrides = envSubs();
  const text = (content ?? "").toLowerCase();

  if (overrides.length > 0) {
    // Env list has no keyword hints; use the first (most-preferred) entry.
    return overrides[0];
  }

  let best = CURATED[0].sub;
  let bestScore = 0;
  for (const { sub, keywords } of CURATED) {
    const score = keywords.reduce(
      (acc, kw) => (text.includes(kw) ? acc + 1 : acc),
      0,
    );
    if (score > bestScore) {
      bestScore = score;
      best = sub;
    }
  }
  return best;
}

// Return the given subreddit if one was supplied, otherwise a content-based
// fallback. Strips a leading "r/" either way.
export function resolveSubreddit(
  supplied: string | null | undefined,
  content: string | null | undefined,
): string {
  return normalizeSub(supplied) || pickDefaultSubreddit(content);
}
