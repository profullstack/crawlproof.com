// Pure logic for Reddit outreach.
//
// The tool this is modelled on (signal-found/sf-mcp) advertises "thousands of
// DMs per day" from a managed farm of Reddit accounts driven through a
// browser extension. That is not what this is. Reddit bans the accounts that
// do it, the subreddits ban the domain, and it does not survive contact with
// a moderator. What actually works on Reddit — answering a question someone
// asked, in public, with a disclosure — is a low-volume activity, so the
// throttles here are part of the design rather than a safety bolt-on.
//
// Everything is side-effect free; the API calls live in
// lib/sp/platforms/redditOutreach.ts.

export type RedditThread = {
  id: string; // t3_xxxxx
  subreddit: string;
  title: string;
  selftext: string;
  author: string;
  permalink: string;
  createdUtc: number; // seconds
  numComments: number;
  score: number;
  over18: boolean;
  locked?: boolean;
  archived?: boolean;
};

export type ThreadRelevance = {
  score: number; // 0-100
  reasons: string[];
  disqualified: string | null;
};

/**
 * Subreddits where any commercial reply is against the rules or the culture,
 * regardless of how relevant it is. Not exhaustive — the rules check on the
 * live subreddit is the real gate — but these come up constantly for a
 * dev-tools product and a static list saves an API call and a mistake.
 */
export const NO_PROMO_SUBREDDITS = new Set(
  [
    "AskReddit",
    "explainlikeimfive",
    "NoStupidQuestions",
    "personalfinance",
    "legaladvice",
    "AmItheAsshole",
    "todayilearned",
    "science",
    "askscience",
    "news",
    "worldnews",
    "politics",
  ].map((s) => s.toLowerCase()),
);

/** Rule text that means "no self-promotion" even when phrased in-house. */
const NO_PROMO_RULE_RE =
  /(no|banned|prohibited|not allowed)[^.]{0,40}(self[- ]?promo|promotion|advertis|solicit|marketing|referral|vendor)|(self[- ]?promo|advertising|soliciting)[^.]{0,30}(is|are)?[^.]{0,20}(not allowed|banned|prohibited|forbidden)/i;

export function rulesForbidPromotion(rules: Array<{ shortName?: string; description?: string }>): string | null {
  for (const rule of rules) {
    const text = `${rule.shortName ?? ""} ${rule.description ?? ""}`;
    if (NO_PROMO_RULE_RE.test(text)) return (rule.shortName ?? text).trim().slice(0, 120);
  }
  return null;
}

const HOURS = 3600;

export type RelevanceInput = {
  thread: RedditThread;
  /** Words that indicate the poster has the problem we solve. */
  keywords: string[];
  /** Words that mean this thread is the wrong kind of match. */
  negativeKeywords?: string[];
  /** Threads older than this are cold; replying reads as necro-posting. */
  maxAgeHours?: number;
  nowSeconds: number;
};

/**
 * Score how worth answering a thread is. Recency and question-shape dominate:
 * a two-hour-old question with three comments is a conversation you can join,
 * and a nine-month-old thread with four hundred is an audience you can only
 * spam.
 */
export function scoreThread(input: RelevanceInput): ThreadRelevance {
  const { thread, nowSeconds } = input;
  const maxAgeHours = input.maxAgeHours ?? 72;
  const haystack = `${thread.title}\n${thread.selftext}`.toLowerCase();
  const reasons: string[] = [];

  if (thread.over18) return { score: 0, reasons: [], disqualified: "NSFW thread" };
  if (thread.locked) return { score: 0, reasons: [], disqualified: "thread is locked" };
  if (thread.archived) return { score: 0, reasons: [], disqualified: "thread is archived" };
  if (NO_PROMO_SUBREDDITS.has(thread.subreddit.toLowerCase())) {
    return { score: 0, reasons: [], disqualified: `r/${thread.subreddit} forbids commercial replies` };
  }

  const ageHours = Math.max(0, (nowSeconds - thread.createdUtc) / HOURS);
  if (ageHours > maxAgeHours) {
    return {
      score: 0,
      reasons: [],
      disqualified: `${Math.round(ageHours / 24)}d old — past the ${maxAgeHours}h window`,
    };
  }

  const negatives = (input.negativeKeywords ?? []).filter((k) => haystack.includes(k.toLowerCase()));
  if (negatives.length) {
    return { score: 0, reasons: [], disqualified: `negative match: ${negatives.join(", ")}` };
  }

  const hits = input.keywords.filter((k) => haystack.includes(k.toLowerCase()));
  if (!hits.length) return { score: 0, reasons: [], disqualified: "no keyword match" };

  let score = Math.min(40, hits.length * 15);
  reasons.push(`matches ${hits.join(", ")}`);

  if (ageHours <= 6) {
    score += 25;
    reasons.push("posted in the last 6h");
  } else if (ageHours <= 24) {
    score += 15;
    reasons.push("posted today");
  } else {
    score += 5;
  }

  // A question is an invitation. A statement is not.
  if (/\?|^(how|what|why|does|is|can|should|anyone|any one|looking for|recommend)/i.test(thread.title)) {
    score += 15;
    reasons.push("asks a question");
  }

  // Few comments means the answer is still wanted. Many means it is settled
  // and a late commercial reply is just advertising under someone's post.
  if (thread.numComments <= 5) {
    score += 15;
    reasons.push(`only ${thread.numComments} comments — answer still open`);
  } else if (thread.numComments <= 20) {
    score += 5;
  } else {
    score -= 10;
    reasons.push(`${thread.numComments} comments — likely already answered`);
  }

  if (thread.selftext.length > 280) {
    score += 5;
    reasons.push("detailed post");
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, disqualified: null };
}

export type RedditChannel = "comment" | "dm";

export type RedditSuppressionInput = {
  /** Reddit username, without u/. */
  username: string;
  /** On the do-not-contact list. */
  suppressed: boolean;
  /** We have contacted this user before, on any thread. */
  contactedBefore: boolean;
  /** We have already replied in this thread. */
  repliedInThread: boolean;
  sentToday: number;
  dailyCap: number;
  sentInSubredditToday: number;
  subredditCap: number;
  /** Result of rulesForbidPromotion for the target subreddit, if checked. */
  subredditForbidsPromotion?: string | null;
  channel: RedditChannel;
};

export type RedditSuppressionReason =
  | "suppressed"
  | "already-contacted"
  | "already-replied-in-thread"
  | "daily-cap"
  | "subreddit-cap"
  | "subreddit-forbids-promotion"
  | "self";

export function redditSuppressionReason(
  input: RedditSuppressionInput,
): RedditSuppressionReason | null {
  if (input.suppressed) return "suppressed";
  // One unsolicited DM per person, ever. A second one is harassment with a
  // funnel attached, and it is what gets an account permanently suspended.
  if (input.channel === "dm" && input.contactedBefore) return "already-contacted";
  if (input.channel === "comment" && input.repliedInThread) return "already-replied-in-thread";
  if (input.subredditForbidsPromotion) return "subreddit-forbids-promotion";
  if (input.sentToday >= input.dailyCap) return "daily-cap";
  if (input.sentInSubredditToday >= input.subredditCap) return "subreddit-cap";
  return null;
}

export function explainRedditSuppression(reason: RedditSuppressionReason): string {
  switch (reason) {
    case "suppressed":
      return "on the do-not-contact list";
    case "already-contacted":
      return "already DM'd once — a second unsolicited DM is harassment";
    case "already-replied-in-thread":
      return "we already replied in this thread";
    case "daily-cap":
      return "over the daily Reddit outreach cap";
    case "subreddit-cap":
      return "over the per-subreddit daily cap";
    case "subreddit-forbids-promotion":
      return "the subreddit's own rules forbid promotional replies";
    case "self":
      return "that is the connected account itself";
  }
}

/**
 * Phrases that must appear for a reply to count as disclosed. Reddit's
 * self-promotion norm is not "don't mention your product" — it is "don't
 * pretend you're a happy customer". Anything with a link to our own site has
 * to say whose site it is.
 */
const DISCLOSURE_RE =
  /\b(i (built|make|made|work on|run)|we (built|make|made|run)|disclosure|full disclosure|i'?m the (founder|dev|developer|author)|my (tool|site|project|company))\b/i;

export type ReplyValidation = { ok: boolean; problems: string[] };

/**
 * Gate on the generated reply before it can be posted. These are the four
 * things that make a Reddit reply read as a bot, and every one of them is
 * mechanically checkable.
 */
export function validateReply(input: {
  body: string;
  siteHost: string;
  channel: RedditChannel;
  /** The thread being answered, for the relevance check. */
  thread?: Pick<RedditThread, "title" | "selftext">;
}): ReplyValidation {
  const problems: string[] = [];
  const body = input.body.trim();
  const lower = body.toLowerCase();
  const linksToUs = lower.includes(input.siteHost.toLowerCase());

  if (!body) problems.push("empty body");
  if (linksToUs && !DISCLOSURE_RE.test(body)) {
    problems.push(
      "links to our own site without disclosing that we built it — add 'I built X' or 'disclosure: I work on X'",
    );
  }
  if (body.length > 1500) {
    problems.push("over 1500 characters — a wall of text under someone's question reads as an ad");
  }
  // A reply that opens on our product answers a question nobody asked.
  const firstSentence = body.split(/(?<=[.!?])\s/)[0] ?? body;
  if (linksToUs && firstSentence.toLowerCase().includes(input.siteHost.toLowerCase())) {
    problems.push("leads with our own link — answer the question first, mention the tool last");
  }
  if (/\b(dm me|check out my|limited time|book a call|special offer|act now)\b/i.test(body)) {
    problems.push("contains sales-pitch phrasing that reads as spam on Reddit");
  }
  if (input.channel === "dm" && !/\b(you (posted|asked|mentioned)|your post|in r\/)/i.test(body)) {
    problems.push(
      "a cold DM must name the specific post it is responding to, or it is indistinguishable from a mailshot",
    );
  }
  return { ok: problems.length === 0, problems };
}

/** Stable key for "have we already touched this?" dedupe. */
export function redditTargetKey(input: {
  channel: RedditChannel;
  username: string;
  threadId: string;
}): string {
  return input.channel === "dm"
    ? `dm:${input.username.toLowerCase()}`
    : `comment:${input.threadId.toLowerCase()}`;
}

/**
 * Build the search queries to run. Reddit's search is weak at boolean logic,
 * so several narrow queries beat one wide one — and per-subreddit search
 * returns better-targeted results than a site-wide sweep.
 */
export function buildSearchQueries(input: {
  keywords: string[];
  subreddits: string[];
}): Array<{ subreddit: string | null; query: string }> {
  const queries: Array<{ subreddit: string | null; query: string }> = [];
  const keywords = input.keywords.slice(0, 6);
  if (!input.subreddits.length) {
    for (const k of keywords) queries.push({ subreddit: null, query: k });
    return queries;
  }
  for (const sub of input.subreddits.slice(0, 8)) {
    const clean = sub.replace(/^\/?r\//, "").trim();
    if (!clean) continue;
    for (const k of keywords) queries.push({ subreddit: clean, query: k });
  }
  return queries;
}
