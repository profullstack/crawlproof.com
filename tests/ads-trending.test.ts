import { describe, expect, it } from "vitest";
import {
  PROMO_DAYS,
  TREND_MATCH_MULTIPLIER,
  TREND_MAX_AGE_HOURS,
  cleanTopics,
  clickChargeCents,
  competesForPaid,
  fillTier,
  matchTrend,
  normalizeTopic,
  pageTopics,
  promoState,
  promoWindow,
  topicsIntersect,
  trendWeight,
  trendsAreStale,
  type TrendSignal,
} from "@/lib/ads/trending";
import { parseTrendPayload } from "@/lib/ads/trends";
import { parseCampaignPatch, parseCampaignRequest } from "@/lib/ads/campaign-request";
import { TRENDING_CPC_CENTS, CREDIT_CENTS, trendingCpcCredits } from "@/lib/ads/pricing";
import { campaignBodyFromArgs, promoLine, parseArgs } from "@/cli/index";

const DAY = 24 * 60 * 60 * 1000;

const signal = (topic: string, score = 10): TrendSignal => ({
  source: "samebrain",
  topic,
  score,
  mentions: 5,
  priorMentions: 1,
  windowDays: 7,
  generatedAt: null,
  ingestedAt: new Date().toISOString(),
});

describe("topics", () => {
  it("normalises to the same subject however it was typed", () => {
    expect(normalizeTopic("Dog Walking!")).toBe("dog walking");
    expect(normalizeTopic("dog-walking")).toBe("dog walking");
    expect(normalizeTopic("Recipes")).toBe("recipe");
    expect(normalizeTopic("   ")).toBe("");
  });

  it("matches on whole words, never on a substring", () => {
    // The classic version of this bug: "art" matching "smart".
    expect(topicsIntersect(["art"], ["smart home"])).toEqual([]);
    expect(topicsIntersect(["dog walking"], ["dog walking roster"])).toEqual(["dog walking"]);
    expect(topicsIntersect(["payment"], ["payment link"])).toEqual(["payment"]);
    expect(topicsIntersect(["crypto payroll"], ["recipe", "meal planner"])).toEqual([]);
  });

  it("reads a page's subject from what CrawlProof already knows about the site", () => {
    const topics = pageTopics({
      masterKeywords: ["dog walking", "pet sitting"],
      niche: "Local pet services",
      slotNiche: null,
      projectName: "Paws & Co",
    });
    expect(topics).toContain("dog walking");
    expect(topics).toContain("pet sitting");
    // An unknown page must end up with SOMETHING or nothing — never a value
    // that matches everything.
    expect(pageTopics({})).toEqual([]);
  });

  it("caps and deduplicates what a campaign may claim", () => {
    expect(cleanTopics(["Dogs", "dog", " dogs "])).toEqual(["dog"]);
    expect(cleanTopics("dog walking, pet sitting")).toEqual(["dog walking", "pet sitting"]);
    expect(cleanTopics(Array.from({ length: 40 }, (_, i) => `topic${i}`))).toHaveLength(12);
    expect(cleanTopics(null)).toEqual([]);
  });
});

describe("matching a campaign to a page", () => {
  const trends = [signal("dog walking", 12), signal("crypto payroll", 30)];

  it("needs BOTH halves: trending, and about this page", () => {
    const onTopic = matchTrend(["dog walking"], ["dog walking roster", "pet sitting"], trends);
    expect(onTopic).toMatchObject({ matched: true, topics: ["dog walking"] });
    expect(onTopic.score).toBe(12);

    // Trending, but this page is about something else entirely. This is the
    // failure everybody complains about: the crypto ad on the recipe blog.
    expect(matchTrend(["crypto payroll"], ["sourdough", "bread"], trends).matched).toBe(false);

    // About this page, but nobody is asking about it — ordinary contextual
    // targeting, which this feature is not claiming to be.
    expect(matchTrend(["sourdough"], ["sourdough starter"], trends).matched).toBe(false);
  });

  it("matches nothing when any of the three inputs is empty", () => {
    expect(matchTrend([], ["dog walking"], trends).matched).toBe(false);
    expect(matchTrend(["dog walking"], [], trends).matched).toBe(false);
    expect(matchTrend(["dog walking"], ["dog walking"], []).matched).toBe(false);
  });

  it("lifts a match in the auction without silencing anything else", () => {
    const matched = matchTrend(["dog walking"], ["dog walking"], trends);
    const unmatched = matchTrend(["sourdough"], ["dog walking"], trends);
    expect(trendWeight(4, matched)).toBe(4 * TREND_MATCH_MULTIPLIER);
    expect(trendWeight(4, unmatched)).toBe(4);
    // Everything still carries a positive weight, so every eligible campaign
    // can still win a fill — "all ads rotate" is the auction's hard rule.
    expect(trendWeight(0, unmatched)).toBeGreaterThan(0);
    expect(trendWeight(null, matched)).toBeGreaterThan(0);
  });

  it("stops steering delivery once the list is describing a different week", () => {
    const now = Date.now();
    expect(trendsAreStale(new Date(now - 60 * 60 * 1000).toISOString(), now)).toBe(false);
    expect(trendsAreStale(new Date(now - (TREND_MAX_AGE_HOURS + 1) * 60 * 60 * 1000).toISOString(), now)).toBe(true);
    expect(trendsAreStale(null, now)).toBe(true);
    expect(trendsAreStale("not a date", now)).toBe(true);
  });
});

describe("the trend payload another service sends", () => {
  it("keeps what it can use and drops the rest", () => {
    const parsed = parseTrendPayload({
      source: "samebrain",
      window_days: 7,
      generated_at: 1_757_500_000_000,
      topics: [
        { topic: "Dog Walking", score: 12.5, count: 6, prior_count: 1 },
        { topic: "dog walking", score: 3 },
        { topic: "   ", score: 99 },
        { topic: "crypto payroll", score: "not a number" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.signals.map((s) => s.topic)).toEqual(["dog walking", "crypto payroll"]);
    expect(parsed.signals[0]).toMatchObject({ score: 12.5, mentions: 6, priorMentions: 1 });
    expect(parsed.signals[1].score).toBe(0);
    expect(parsed.generatedAt).toBe(new Date(1_757_500_000_000).toISOString());
  });

  it("refuses an answer that is not a trend list", () => {
    expect(parseTrendPayload({})).toMatchObject({ ok: false });
    expect(parseTrendPayload({ topics: "dog walking" })).toMatchObject({ ok: false });
  });
});

describe("the 90-day promo window", () => {
  it("is ninety days from when it was granted", () => {
    const start = Date.parse("2026-09-11T00:00:00.000Z");
    const window = promoWindow(start);
    expect(window.startsAt).toBe("2026-09-11T00:00:00.000Z");
    expect(Date.parse(window.endsAt) - start).toBe(PROMO_DAYS * DAY);
  });

  it("counts down, and the last partial day still reads as a day", () => {
    const start = Date.parse("2026-09-11T00:00:00.000Z");
    const promo = { ...promoWindow(start), cpcCents: TRENDING_CPC_CENTS };

    expect(promoState(promo, start)).toMatchObject({ active: true, daysRemaining: PROMO_DAYS });
    expect(promoState(promo, start + 30 * DAY).daysRemaining).toBe(PROMO_DAYS - 30);
    // Two hours left is still a day left to somebody whose ads are free.
    expect(promoState(promo, start + PROMO_DAYS * DAY - 2 * 60 * 60 * 1000)).toMatchObject({
      active: true,
      daysRemaining: 1,
    });
    // The moment it ends, and after.
    expect(promoState(promo, start + PROMO_DAYS * DAY)).toMatchObject({ active: false, daysRemaining: 0 });
    expect(promoState(promo, start + 365 * DAY).active).toBe(false);
    // Before it starts, it is not running either.
    expect(promoState(promo, start - DAY).active).toBe(false);
  });

  it("is over the moment it is revoked, whatever the end date says", () => {
    const start = Date.parse("2026-09-11T00:00:00.000Z");
    const promo = { ...promoWindow(start), revokedAt: new Date(start + 10 * DAY).toISOString() };
    expect(promoState(promo, start + 5 * DAY).active).toBe(true);
    expect(promoState(promo, start + 11 * DAY).active).toBe(false);
  });

  it("is nothing at all when there is no promo, or the dates are nonsense", () => {
    expect(promoState(null)).toMatchObject({ active: false, daysRemaining: 0, endsAt: null });
    expect(promoState({ startsAt: "never", endsAt: "never" }).active).toBe(false);
  });
});

describe("billing at zero", () => {
  it("charges nothing while the promo runs, and the ordinary rate after", () => {
    const start = Date.now();
    const promo = promoState({ ...promoWindow(start), cpcCents: TRENDING_CPC_CENTS }, start + DAY);
    const ended = promoState({ ...promoWindow(start - 200 * DAY), cpcCents: TRENDING_CPC_CENTS }, start);

    expect(clickChargeCents({ promo, cpcCents: 20 })).toBe(0);
    expect(clickChargeCents({ promo: ended, cpcCents: 20 })).toBe(20);
    expect(clickChargeCents({ promo: promoState(null), cpcCents: 20 })).toBe(20);
  });

  it("quotes the trending CPC as two cents, and says what that is in credits", () => {
    expect(TRENDING_CPC_CENTS).toBe(2);
    // Below one credit (5c), which is why the promo rate is stated in cents
    // and why a post-promo trending campaign still bills at its own bid: the
    // credit path moves whole credits only.
    expect(trendingCpcCredits()).toBeLessThan(1);
    expect(trendingCpcCredits()).toBe(TRENDING_CPC_CENTS / CREDIT_CENTS);
  });

  it("lets a promo campaign compete for the placement it was promised", () => {
    // Money and delivery are different questions. A promo campaign books no
    // money, but "premium ads running" means it competes in the real auction —
    // parked in the backfill pool it would never serve at all on a network
    // that has a paying advertiser.
    expect(competesForPaid({ selfDeal: false, promoActive: true, hasBudget: false, hasFunds: false })).toBe(true);
    // Without a promo, funds and budget still decide.
    expect(competesForPaid({ selfDeal: false, promoActive: false, hasBudget: true, hasFunds: true })).toBe(true);
    expect(competesForPaid({ selfDeal: false, promoActive: false, hasBudget: false, hasFunds: true })).toBe(false);
    // And self-deal never competes for inventory a payer wants, promo or not.
    expect(competesForPaid({ selfDeal: true, promoActive: true, hasBudget: true, hasFunds: true })).toBe(false);
  });

  it("never books a promo or a self-deal fill as paid", () => {
    // Paid is the only tier that can move money.
    expect(fillTier({ selfDeal: false, promoActive: false, hasBudget: true, hasFunds: true })).toBe("paid");

    // A promo click is charged nothing, so the publisher cannot be paid out of
    // it — and on this network, where one account owns both sides of nearly
    // every fill, a paid booking would read as revenue on the ROI dashboard.
    expect(fillTier({ selfDeal: false, promoActive: true, hasBudget: true, hasFunds: true })).toBe("free");
    // Self-deal stays free whether or not a promo is running.
    expect(fillTier({ selfDeal: true, promoActive: true, hasBudget: true, hasFunds: true })).toBe("free");
    expect(fillTier({ selfDeal: true, promoActive: false, hasBudget: true, hasFunds: true })).toBe("free");
    // The existing rules are unchanged.
    expect(fillTier({ selfDeal: false, promoActive: false, hasBudget: false, hasFunds: true })).toBe("free");
    expect(fillTier({ selfDeal: false, promoActive: false, hasBudget: true, hasFunds: false })).toBe("free");
  });
});

describe("asking for trending targeting", () => {
  it("is accepted from the API in either spelling, and clamped", () => {
    const parsed = parseCampaignRequest({
      url: "https://nichedb.dev",
      trending_topics: true,
      topics: ["Dog Walking", "dogs"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.trendingTopics).toBe(true);
    expect(parsed.request.topics).toEqual(["dog walking", "dog"]);

    expect(parseCampaignRequest({ url: "https://nichedb.dev", trending: "true" })).toMatchObject({
      ok: true,
      request: { trendingTopics: true },
    });
    // Silence is not a no: an untouched field must stay untouched.
    const quiet = parseCampaignRequest({ url: "https://nichedb.dev" });
    expect(quiet.ok && quiet.request.trendingTopics).toBeUndefined();
  });

  it("can be turned off again through a patch", () => {
    expect(parseCampaignPatch({ trending_topics: false })).toMatchObject({
      ok: true,
      patch: { trendingTopics: false },
    });
    expect(parseCampaignPatch({ topics: "meal planner" })).toMatchObject({
      ok: true,
      patch: { topics: ["meal planner"] },
    });
    expect(parseCampaignPatch({})).toMatchObject({ ok: false });
  });

  it("travels from the CLI flag into the request body", () => {
    const args = parseArgs(["ads", "create", "https://nichedb.dev", "--trending", "--topics=dog walking,pets"]);
    expect(campaignBodyFromArgs(args)).toMatchObject({
      url: "https://nichedb.dev",
      trending_topics: true,
      topics: ["dog walking", "pets"],
    });
    // Without the flag the body says nothing about trending at all, so an
    // ordinary create cannot turn it on by accident.
    expect(campaignBodyFromArgs(parseArgs(["ads", "create", "https://nichedb.dev"]))).not.toHaveProperty("trending_topics");
  });

  it("tells the advertiser where the promo stands, in one line", () => {
    const start = Date.now();
    const active = promoState({ ...promoWindow(start), cpcCents: TRENDING_CPC_CENTS }, start + DAY);
    expect(promoLine(active)).toContain("89 days left");
    expect(promoLine(active)).toContain("$0.00");
    expect(promoLine(active)).toContain("$0.02");
    expect(promoLine(promoState({ ...promoWindow(start - 200 * DAY) }, start))).toContain("bill normally");
    expect(promoLine(null)).toBe("");
  });
});
