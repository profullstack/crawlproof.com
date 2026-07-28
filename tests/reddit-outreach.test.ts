import { describe, it, expect } from "vitest";
import {
  buildSearchQueries,
  redditSuppressionReason,
  redditTargetKey,
  rulesForbidPromotion,
  scoreThread,
  validateReply,
  type RedditThread,
} from "@/lib/outreach/reddit";

const NOW = 1_800_000_000; // fixed clock; scoring is age-sensitive

function thread(over: Partial<RedditThread> = {}): RedditThread {
  return {
    id: "t3_abc123",
    subreddit: "SEO",
    title: "How do I get ChatGPT to cite my site instead of a competitor?",
    selftext: "We publish a lot but assistants never mention us. Is there an llms.txt thing?",
    author: "someuser",
    permalink: "https://www.reddit.com/r/SEO/comments/abc123/x/",
    createdUtc: NOW - 3600 * 2,
    numComments: 3,
    score: 5,
    over18: false,
    ...over,
  };
}

const KEYWORDS = ["llms.txt", "chatgpt cite", "assistants never mention"];

describe("scoreThread", () => {
  it("rates a fresh, barely-answered question highly", () => {
    const r = scoreThread({ thread: thread(), keywords: KEYWORDS, nowSeconds: NOW });
    expect(r.disqualified).toBeNull();
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.reasons.join(" ")).toMatch(/last 6h/);
  });

  it("disqualifies a thread past the age window", () => {
    const r = scoreThread({
      thread: thread({ createdUtc: NOW - 3600 * 24 * 30 }),
      keywords: KEYWORDS,
      nowSeconds: NOW,
    });
    expect(r.disqualified).toMatch(/window/);
    expect(r.score).toBe(0);
  });

  it("disqualifies locked, archived and NSFW threads", () => {
    for (const over of [{ locked: true }, { archived: true }, { over18: true }]) {
      expect(scoreThread({ thread: thread(over), keywords: KEYWORDS, nowSeconds: NOW }).score).toBe(0);
    }
  });

  it("refuses subreddits where a commercial reply is never welcome", () => {
    const r = scoreThread({
      thread: thread({ subreddit: "AskReddit" }),
      keywords: KEYWORDS,
      nowSeconds: NOW,
    });
    expect(r.disqualified).toMatch(/forbids/);
  });

  it("drops a thread on a negative keyword even when it matches", () => {
    const r = scoreThread({
      thread: thread(),
      keywords: KEYWORDS,
      negativeKeywords: ["competitor"],
      nowSeconds: NOW,
    });
    expect(r.disqualified).toMatch(/negative match/);
  });

  it("penalises a thread that is already thoroughly answered", () => {
    const busy = scoreThread({ thread: thread({ numComments: 120 }), keywords: KEYWORDS, nowSeconds: NOW });
    const quiet = scoreThread({ thread: thread({ numComments: 2 }), keywords: KEYWORDS, nowSeconds: NOW });
    expect(busy.score).toBeLessThan(quiet.score);
  });

  it("scores nothing without a keyword match", () => {
    expect(scoreThread({ thread: thread(), keywords: ["kubernetes"], nowSeconds: NOW }).disqualified).toBe(
      "no keyword match",
    );
  });
});

describe("rulesForbidPromotion", () => {
  it("detects a no-self-promotion rule however it is phrased", () => {
    expect(rulesForbidPromotion([{ shortName: "No self-promotion", description: "" }])).toBeTruthy();
    expect(
      rulesForbidPromotion([{ shortName: "Rule 4", description: "Advertising is not allowed here." }]),
    ).toBeTruthy();
  });

  it("does not fire on ordinary rules", () => {
    expect(
      rulesForbidPromotion([
        { shortName: "Be civil", description: "No personal attacks." },
        { shortName: "Use the weekly thread", description: "Ask small questions there." },
      ]),
    ).toBeNull();
  });
});

describe("redditSuppressionReason", () => {
  const base = {
    username: "someuser",
    suppressed: false,
    contactedBefore: false,
    repliedInThread: false,
    sentToday: 0,
    dailyCap: 10,
    sentInSubredditToday: 0,
    subredditCap: 3,
    channel: "comment" as const,
  };

  it("allows a first public reply", () => {
    expect(redditSuppressionReason(base)).toBeNull();
  });

  it("never sends a second unsolicited DM to the same person", () => {
    expect(redditSuppressionReason({ ...base, channel: "dm", contactedBefore: true })).toBe(
      "already-contacted",
    );
  });

  it("allows a public comment even if that user was DM'd before", () => {
    expect(redditSuppressionReason({ ...base, contactedBefore: true })).toBeNull();
  });

  it("refuses to reply twice in the same thread", () => {
    expect(redditSuppressionReason({ ...base, repliedInThread: true })).toBe("already-replied-in-thread");
  });

  it("honors the subreddit's own rule above our caps", () => {
    expect(
      redditSuppressionReason({ ...base, subredditForbidsPromotion: "No self-promotion", sentToday: 0 }),
    ).toBe("subreddit-forbids-promotion");
  });

  it("enforces both the daily and the per-subreddit cap", () => {
    expect(redditSuppressionReason({ ...base, sentToday: 10 })).toBe("daily-cap");
    expect(redditSuppressionReason({ ...base, sentInSubredditToday: 3 })).toBe("subreddit-cap");
  });

  it("puts an explicit opt-out first", () => {
    expect(redditSuppressionReason({ ...base, suppressed: true, sentToday: 0 })).toBe("suppressed");
  });
});

describe("validateReply", () => {
  const siteHost = "crawlproof.com";

  it("accepts a reply that answers first and discloses at the end", () => {
    const body =
      "Assistants mostly read your rendered HTML, so start by checking robots.txt isn't blocking GPTBot and that your key pages have real text rather than JS-only content. Disclosure: I built crawlproof.com, which checks exactly that.";
    expect(validateReply({ body, siteHost, channel: "comment" }).ok).toBe(true);
  });

  it("rejects a link with no ownership disclosure", () => {
    const check = validateReply({
      body: "You should try crawlproof.com, it's great for this.",
      siteHost,
      channel: "comment",
    });
    expect(check.ok).toBe(false);
    expect(check.problems.join(" ")).toMatch(/disclos/i);
  });

  it("rejects a reply that leads with our own link", () => {
    const check = validateReply({
      body: "crawlproof.com does this — I built it. Also check your robots.txt.",
      siteHost,
      channel: "comment",
    });
    expect(check.problems.join(" ")).toMatch(/leads with/);
  });

  it("rejects sales-pitch phrasing", () => {
    const check = validateReply({
      body: "DM me and I'll sort it out for you, limited time.",
      siteHost,
      channel: "comment",
    });
    expect(check.ok).toBe(false);
  });

  it("rejects a wall of text", () => {
    const check = validateReply({ body: "x".repeat(1600), siteHost, channel: "comment" });
    expect(check.problems.join(" ")).toMatch(/1500 characters/);
  });

  it("requires a cold DM to name the post it answers", () => {
    const generic = validateReply({ body: "Hi, thought this might help you.", siteHost, channel: "dm" });
    expect(generic.ok).toBe(false);
    const specific = validateReply({
      body: "You posted in r/SEO about assistants not citing you — the usual cause is a robots.txt block.",
      siteHost,
      channel: "dm",
    });
    expect(specific.ok).toBe(true);
  });
});

describe("redditTargetKey", () => {
  it("dedupes DMs per person and comments per thread", () => {
    expect(redditTargetKey({ channel: "dm", username: "SomeUser", threadId: "t3_a" })).toBe("dm:someuser");
    expect(redditTargetKey({ channel: "comment", username: "SomeUser", threadId: "t3_A" })).toBe(
      "comment:t3_a",
    );
  });
});

describe("buildSearchQueries", () => {
  it("fans keywords across each subreddit", () => {
    const queries = buildSearchQueries({ keywords: ["llms.txt", "aeo"], subreddits: ["SEO", "r/juststart"] });
    expect(queries).toHaveLength(4);
    expect(queries[0]).toEqual({ subreddit: "SEO", query: "llms.txt" });
    // A leading r/ is stripped rather than searched literally.
    expect(queries.some((q) => q.subreddit === "juststart")).toBe(true);
  });

  it("falls back to a sitewide search with no subreddits", () => {
    const queries = buildSearchQueries({ keywords: ["llms.txt"], subreddits: [] });
    expect(queries).toEqual([{ subreddit: null, query: "llms.txt" }]);
  });
});
