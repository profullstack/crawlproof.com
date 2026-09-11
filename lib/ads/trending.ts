// Trending-topic targeting.
//
// An advertiser can say "run my ads where the subject is what people are
// asking about right now". Two halves have to agree before that means
// anything: the campaign's own subjects have to be trending, AND the page
// being filled has to be about one of them. Either half alone is how ad
// networks end up putting crypto ads on a recipe blog because crypto was in
// the news.
//
// The trend list comes from outside (lib/ads/trends.ts pulls it); the page's
// subject comes from what CrawlProof already knows about the site — its
// autoblog master keywords, its niche, the slot's own niche. Nothing here
// reaches a database or a network: it is the matching and the money rules, so
// both can be tested without either.

import { DEFAULT_BID_CREDITS } from "./pricing";

/** The only trend source today: chovy.com's SameBrain read on what founders are building. */
export const TREND_SOURCE = "samebrain";

/** Default window to target on, matching what the source ranks over. */
export const TREND_WINDOW_DAYS = 7;

/**
 * How stale a trend list may be and still steer delivery.
 *
 * A pull runs hourly; a day of failed pulls is a list describing last week,
 * and the honest thing to do with it is stop targeting on it rather than keep
 * preferring yesterday's subjects forever. Past this age every campaign falls
 * back to its ordinary auction weight, so a broken ingest degrades to the
 * behaviour that existed before this feature.
 */
export const TREND_MAX_AGE_HOURS = 36;

/**
 * How much a trending match is worth in the auction, as a multiplier on the
 * campaign's own bid weight.
 *
 * Deliberately a preference, not a rule: a matched campaign wins more often,
 * every other eligible campaign still rotates. "All ads rotate" is a hard
 * requirement of the auction (see lib/ads/auction.ts) and a targeting feature
 * that silently starved everything else would break it.
 */
export const TREND_MATCH_MULTIPLIER = 4;

export type TrendSignal = {
  source: string;
  topic: string;
  score: number;
  mentions: number;
  priorMentions: number;
  windowDays: number;
  generatedAt: string | null;
  ingestedAt: string | null;
};

// ------------------------------------------------------------------ terms

/**
 * Light stemming, so "recipes" and "recipe" are one subject.
 *
 * One character off `-es` by default and two only after a sibilant: "codes" is
 * "code", "boxes" is "box". Always taking two turns "codes" into "cod" and
 * every plural quietly stops matching its singular — the autoblog stemmer had
 * exactly that bug.
 */
export function stem(word: string): string {
  const value = String(word || "");
  if (value.length <= 3) return value;
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith("es")) {
    const before = value.slice(0, -2);
    return /(s|x|z|ch|sh)$/.test(before) ? before : value.slice(0, -1);
  }
  if (value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

/**
 * A topic as it is stored and compared: lowercase, stemmed word by word,
 * punctuation gone. "Dog Walking!" and "dog walkings" are the same subject.
 */
export function normalizeTopic(topic: string): string {
  return String(topic || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#\s-]+/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length >= 2 && word.length <= 24)
    .map((word) => stem(word))
    .join(" ")
    .trim();
}

/** Normalised, deduplicated, and capped. What goes into `ad_campaigns.topics`. */
export function cleanTopics(input: unknown, max = 12): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [];
  const out: string[] = [];
  for (const item of raw) {
    const topic = normalizeTopic(String(item));
    if (!topic) continue;
    if (!out.includes(topic)) out.push(topic);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The subjects a page or a site is about, from whatever CrawlProof knows.
 *
 * The autoblog already answers this question for every site it writes for —
 * `lx_site.master_keywords` is a hand-checked 3-12 subject list and `niche` is
 * the sentence it was derived from. The slot may carry its own niche, and the
 * project's name is the last resort. Anything is better than treating an
 * unknown page as matching everything, which is the failure mode that puts an
 * ad for payroll software on a fishing blog.
 */
export function pageTopics(input: {
  masterKeywords?: string[] | null;
  niche?: string | null;
  slotNiche?: string | null;
  projectName?: string | null;
}): string[] {
  const parts = [
    ...(input.masterKeywords ?? []),
    ...(input.slotNiche ? [input.slotNiche] : []),
    ...(input.niche ? [input.niche] : []),
    ...(input.projectName ? [input.projectName] : []),
  ];
  return cleanTopics(parts, 24);
}

/**
 * Do two subject lists mean the same thing?
 *
 * A match is an exact normalised equality, or one being a whole-word phrase
 * inside the other: "dog walking" matches "dog walking roster", and "payment"
 * matches "payment link". Substring matching without the word boundary is how
 * "art" matches "smart", which is the classic version of this mistake.
 */
export function topicsIntersect(left: string[], right: string[]): string[] {
  const found: string[] = [];
  for (const a of left) {
    for (const b of right) {
      if (!a || !b) continue;
      const contains =
        a === b ||
        ` ${a} `.includes(` ${b} `) ||
        ` ${b} `.includes(` ${a} `);
      if (contains && !found.includes(a)) found.push(a);
    }
  }
  return found;
}

export type TrendMatch = {
  /** The campaign's subjects that are both trending and on this page. */
  topics: string[];
  matched: boolean;
  /** Summed trend score of the matched subjects, for reporting. */
  score: number;
};

/**
 * Does this campaign belong on this page right now?
 *
 * Both halves, deliberately: the campaign's subject has to be trending AND the
 * page has to be about it. A campaign about a trending subject on an unrelated
 * page is the thing publishers complain about, and a campaign matching the
 * page but on no trend is just ordinary contextual targeting, which this
 * feature is not claiming to be.
 */
export function matchTrend(
  campaignTopics: string[],
  page: string[],
  trends: TrendSignal[],
): TrendMatch {
  if (!campaignTopics.length || !page.length || !trends.length) {
    return { topics: [], matched: false, score: 0 };
  }
  const trendTopics = trends.map((t) => normalizeTopic(t.topic)).filter(Boolean);
  const trending = topicsIntersect(campaignTopics, trendTopics);
  if (!trending.length) return { topics: [], matched: false, score: 0 };
  const onPage = topicsIntersect(trending, page);
  if (!onPage.length) return { topics: [], matched: false, score: 0 };

  let score = 0;
  for (const topic of onPage) {
    for (const signal of trends) {
      if (topicsIntersect([topic], [normalizeTopic(signal.topic)]).length) {
        score += Number(signal.score) || 0;
      }
    }
  }
  return { topics: onPage, matched: true, score: Math.round(score * 100) / 100 };
}

/** Auction weight for a candidate: its bid, lifted while it is a trending match. */
export function trendWeight(bidCredits: number | null | undefined, match: TrendMatch): number {
  const bid = Number(bidCredits) > 0 ? Number(bidCredits) : DEFAULT_BID_CREDITS;
  return match.matched ? bid * TREND_MATCH_MULTIPLIER : bid;
}

/** A trend list old enough to be describing a different week. */
export function trendsAreStale(ingestedAt: string | null | undefined, now = Date.now()): boolean {
  if (!ingestedAt) return true;
  const at = Date.parse(ingestedAt);
  if (!Number.isFinite(at)) return true;
  return now - at > TREND_MAX_AGE_HOURS * 60 * 60 * 1000;
}

// ------------------------------------------------------------------ promo

/** The one promo kind: trending targeting on, premium delivery, ninety days free. */
export const PROMO_KIND = "trending_premium_90";
export const PROMO_DAYS = 90;

export type Promo = {
  id?: string;
  ownerId?: string;
  campaignId?: string | null;
  kind?: string;
  cpcCents?: number;
  startsAt: string;
  endsAt: string;
  revokedAt?: string | null;
};

export type PromoState = {
  active: boolean;
  daysRemaining: number;
  startsAt: string | null;
  endsAt: string | null;
  /** The rate the advertiser pays once it ends, in cents per click. */
  cpcCents: number;
};

export const NO_PROMO: PromoState = {
  active: false,
  daysRemaining: 0,
  startsAt: null,
  endsAt: null,
  cpcCents: 0,
};

/** The window a promo granted now would cover. */
export function promoWindow(startedAt: Date | number = Date.now()): { startsAt: string; endsAt: string } {
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const end = new Date(start.getTime() + PROMO_DAYS * 24 * 60 * 60 * 1000);
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

/**
 * Where a promo stands, right now.
 *
 * Days remaining is rounded UP, so the last partial day still reads as "1 day
 * left" rather than "0" to somebody whose ads are demonstrably still free. It
 * reaches 0 only once the promo is actually over.
 */
export function promoState(promo: Promo | null | undefined, now: number = Date.now()): PromoState {
  if (!promo) return NO_PROMO;
  const start = Date.parse(promo.startsAt);
  const end = Date.parse(promo.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return NO_PROMO;
  const revoked = promo.revokedAt ? Date.parse(promo.revokedAt) : NaN;
  const endsAtMs = Number.isFinite(revoked) ? Math.min(end, revoked) : end;
  const active = now >= start && now < endsAtMs;
  return {
    active,
    daysRemaining: active ? Math.max(1, Math.ceil((endsAtMs - now) / (24 * 60 * 60 * 1000))) : 0,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(endsAtMs).toISOString(),
    cpcCents: Number(promo.cpcCents) || 0,
  };
}

/**
 * What a click costs, in cents.
 *
 * Zero while the promo runs. This is the whole promo: the ad serves, the
 * impression is recorded, the click is recorded, and the advertiser is charged
 * nothing. Metering is deliberately unchanged — a promo that also stopped
 * counting would leave the advertiser with ninety days of ads and no evidence
 * they ran.
 */
export function clickChargeCents(input: { promo: PromoState; cpcCents: number }): number {
  if (input.promo.active) return 0;
  return Math.max(0, Math.round(input.cpcCents));
}

/**
 * Which campaigns compete for the inventory a paying advertiser wants.
 *
 * Money and delivery are two different questions, and conflating them was a
 * bug: a promo campaign books no money (see fillTier below), but it is a
 * PREMIUM placement — that is what was promised — so it has to compete in the
 * real auction rather than sit in the backfill pool where it would only ever
 * fill requests nobody else wanted. On a network with paying advertisers a
 * promo campaign would otherwise never serve at all.
 *
 * It competes without funds on purpose: an advertiser inside their ninety days
 * is not spending credits, so requiring a balance would make the promo
 * conditional on the thing it exists to waive.
 *
 * Self-deal still never competes for paid inventory: that rule is about not
 * displacing an advertiser who would actually pay, and it predates all of this.
 */
export function competesForPaid(input: {
  selfDeal: boolean;
  promoActive: boolean;
  hasBudget: boolean;
  hasFunds: boolean;
}): boolean {
  if (input.selfDeal) return false;
  if (input.promoActive) return true;
  return input.hasBudget && input.hasFunds;
}

/**
 * Which tier a fill books under.
 *
 * 'paid' is the only tier that can move money, and three separate situations
 * must never reach it:
 *
 *   * self-deal — the same account owns the slot and the campaign, so there is
 *     no money to move and ad_charge_click refuses to bill it anyway. It gets
 *     the free tier rather than being dropped, because dropping self-owned
 *     campaigns once removed 100% of this network's inventory (PR #177).
 *   * promo — the advertiser is not being charged, so the publisher cannot be
 *     paid out of a payment that is not happening. Free tier is what "real
 *     delivery, no money" already means here.
 *   * out of budget or out of credit — the existing rule, unchanged.
 *
 * The promo case matters most on THIS network, where every slot and every
 * campaign belong to one account: a promo that booked as paid would write
 * spend and publisher earnings on both sides of the same pocket and read as
 * revenue on the ROI dashboard. It is not revenue. It is a discount we gave
 * ourselves, and it books as free.
 *
 * This is about the money only. Which campaigns compete for the placement is
 * `competesForPaid` above, and a promo campaign competes.
 */
export function fillTier(input: {
  selfDeal: boolean;
  promoActive: boolean;
  hasBudget: boolean;
  hasFunds: boolean;
}): "paid" | "free" {
  if (input.selfDeal || input.promoActive) return "free";
  return input.hasBudget && input.hasFunds ? "paid" : "free";
}
