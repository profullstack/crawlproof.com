// Buying intent, as a signal you can sort by.
//
// The premise this encodes, which came from someone who had already built a
// business on it: cold outreach to people who have shown no intent converts
// badly regardless of how good the copy is, and no amount of firmographic
// targeting fixes that. Someone who posted "anyone know a good X, happy to
// pay" four hours ago is a different prospect from a company that merely
// resembles your customers — not a better-matched one, a categorically
// different one.
//
// So intent and recency are scored as the primary signal, and everything the
// rest of the pipeline does well — finding addresses, grounding drafts — is
// downstream of choosing who to write to at all.
//
// Deliberately source-agnostic. A Reddit thread, a forum post, a job ad, a
// tweet and a status page all reduce to "someone said this, at this time", and
// a scorer that only understands one platform makes every new source a rewrite.
// The adapters live in intentSources.ts; this file knows nothing about where
// the words came from.

/**
 * Hours after which a signal has decayed to roughly half its strength.
 *
 * Matches the 72-hour window the Reddit scorer already treats as the edge of
 * repliable, rather than a number chosen independently. The first value here
 * was 36, which priced a day-old "can anyone recommend a X" at barely more
 * than a fresh unattributed grumble — and those threads stay answerable for
 * days. Replying to a three-day-old request costs little; missing it costs a
 * lead.
 */
const HALF_LIFE_HOURS = 72;
/** Past this, treat a signal as stale regardless of how strong it was. */
const MAX_AGE_HOURS = 24 * 14;

export type IntentTier = "purchase" | "solicitation" | "switching" | "pain" | "none";

type TierSpec = {
  tier: Exclude<IntentTier, "none">;
  /** Base score before recency is applied. */
  weight: number;
  label: string;
  patterns: RegExp[];
};

/**
 * Ordered strongest first. The tiers are distinct kinds of statement, not
 * degrees of the same one:
 *
 * - purchase: money is already on the table.
 * - switching: they have a supplier and are leaving. The budget exists and
 *   the decision to spend it has been made — which is why this outranks a
 *   general request for suggestions.
 * - solicitation: asking the room for a recommendation.
 * - pain: describing a problem without asking for anything.
 */
const TIERS: TierSpec[] = [
  {
    tier: "purchase",
    weight: 100,
    label: "ready to pay",
    patterns: [
      /\b(?:looking|want|wanting|ready|keen)\s+to\s+(?:buy|purchase|pay)\b/i,
      /\b(?:willing|happy|glad)\s+to\s+pay\b/i,
      /\b(?:we|i)\s+(?:have|got)\s+(?:a\s+)?budget\b/i,
      /\bbudget\s+(?:of|for|is|around|up to)\b/i,
      /\b(?:take|shut up and take)\s+my\s+money\b/i,
      /\b(?:request for proposal|rfp|rfq)\b/i,
      /\b(?:get|need|send|want)\s+(?:a\s+)?(?:quote|quotes|pricing)\b/i,
      /\bwho\s+(?:do|should)\s+(?:i|we)\s+pay\b/i,
      // Engaging a firm is a purchase; taking on a person is employment, and
      // the two read alike. Only the first is a buyer.
      /\b(?:hire|hiring|engage|retain|onboard)\s+(?:an?\s+)?(?:agency|vendor|supplier|firm|consultancy|consultants?|provider|partner)\b/i,
      /\bpaid\s+(?:tool|service|plan|option|solution)\b/i,
      /\bhappy\s+to\s+(?:pay|spend)\b/i,
      // Mid-purchase by definition. Someone comparing vendors in public has
      // already decided to buy something and is choosing between suppliers,
      // which is later in the process than saying they are willing to pay.
      /\b(?:evaluating|shortlisting|comparing|trialling|trialing|piloting)\s+(?:\w+\s+){0,2}(?:tools?|vendors?|suppliers?|options?|providers?|platforms?|solutions?)\b/i,
      /\b(?:we(?:'re| are)?)\s+(?:evaluating|shortlisting|comparing|procuring)\b/i,
      /\b(?:vendor|supplier|security|procurement)\s+review\b/i,
      /\b(?:proof of concept|poc|bake[- ]off)\b/i,
    ],
  },
  {
    tier: "switching",
    weight: 85,
    label: "leaving their current supplier",
    patterns: [
      /\b(?:migrating|moving|switching|shifting)\s+(?:away\s+)?(?:from|off)\b/i,
      /\blooking\s+(?:to|for)\s+(?:a\s+)?replace(?:ment)?\b/i,
      /\b(?:replacing|replace)\s+(?:our|my|the)\b/i,
      /\b(?:cancelled|canceling|cancelling|dropping|ditching)\s+(?:our|my)\b/i,
      /\balternatives?\s+to\b/i,
      /\bfed\s+up\s+with\b/i,
      /\bcontract\s+(?:is\s+)?(?:up|expiring|ending|renewing)\b/i,
    ],
  },
  {
    tier: "solicitation",
    weight: 70,
    label: "asking for a recommendation",
    patterns: [
      /\b(?:anyone|anybody)\s+(?:know|use|used|recommend|tried)\b/i,
      /\b(?:can|could)\s+(?:anyone|anybody|someone)\s+recommend\b/i,
      /\brecommendations?\s+for\b/i,
      /\b(?:looking|searching|hunting)\s+for\s+(?:a|an|some)\b/i,
      /\bin\s+search\s+of\b/i,
      /\bsuggestions?\s+for\b/i,
      /\bwhat(?:'s| is| are)\s+the\s+best\b/i,
      /\bwhich\s+(?:tool|service|vendor|provider|agency|platform)\b/i,
      /\bwhat\s+(?:do|are)\s+you\s+(?:all\s+)?(?:use|using)\b/i,
      /\bany\s+(?:tools?|services?|vendors?|agencies)\s+that\b/i,
      /\bany\s+recommendations?\b/i,
      // "We need a X" is the plainest way a team states a requirement, and
      // omitting it lost exactly the plural-first-person phrasing that marks
      // somebody buying on an organisation's behalf.
      /\b(?:we|our team|i)\s+(?:need|want|require)\s+(?:a|an|some|better|new)\b/i,
      /\blooking\s+(?:to|at)\s+(?:replace|adopt|introduce|bring in)\b/i,
    ],
  },
  {
    tier: "pain",
    weight: 45,
    label: "describing a problem",
    patterns: [
      /\b(?:struggling|struggle)\s+with\b/i,
      /\b(?:sick|tired)\s+of\b/i,
      /\b(?:frustrated|frustrating)\b/i,
      /\bcan(?:'|no)?t\s+(?:figure|get|work)\b/i,
      /\b(?:keeps|constantly)\s+(?:failing|breaking|crashing)\b/i,
      /\b(?:manual|by hand)\s+(?:process|work|workflow)\b/i,
      /\b(?:wasting|spending)\s+(?:hours|days|so much time)\b/i,
      /\bis\s+there\s+(?:a|any)\s+(?:tool|way|service)\b/i,
    ],
  },
];

/**
 * Statements that mean this is not a lead however well it otherwise scores.
 *
 * These are cheap to check and expensive to get wrong in the other direction:
 * messaging someone who wrote "no vendors please" is the fastest way to lose
 * a channel for everybody.
 */
const DISQUALIFIERS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bno\s+(?:vendors?|sales|solicitation|pitches|promos?|ads?)\b/i, reason: "asked not to be pitched" },
  { pattern: /\b(?:do\s*n(?:o|')t|please\s+don'?t)\s+(?:dm|pm|message|contact|email)\s+me\b/i, reason: "asked not to be contacted" },
  { pattern: /\bnot\s+looking\s+(?:to\s+(?:buy|pay)|for\s+(?:a\s+)?(?:vendor|tool|service))\b/i, reason: "explicitly not buying" },
  { pattern: /\b(?:free|open[- ]source)\s+only\b/i, reason: "free/open-source only" },
  { pattern: /\bno\s+paid\b/i, reason: "free/open-source only" },
  { pattern: /\bthis\s+is\s+(?:an?\s+)?(?:ad|advert|sponsored)\b/i, reason: "the post is itself an advert" },
  { pattern: /\bwe(?:'re| are)\s+hiring\b/i, reason: "a job ad, not a buyer" },
  // Someone advertising their own services is the exact inverse of a lead,
  // and reads almost identically to one: same vocabulary, same topic, same
  // enthusiasm. Freelance and job boards are full of these, which is why the
  // sweep no longer trawls them.
  { pattern: /\b(?:available|open)\s+(?:for|to)\s+(?:hire|work|freelance|contract|new clients?|projects?)\b/i, reason: "selling their own services" },
  { pattern: /\b(?:hire|dm|message|contact)\s+me\b/i, reason: "selling their own services" },
  { pattern: /\b(?:my|our)\s+(?:rates?|portfolio|services|day rate)\b/i, reason: "selling their own services" },
  { pattern: /\b(?:i|we)\s+(?:offer|provide|specialis[ez]e in|do)\s+\w+\s+(?:services|work|consulting)\b/i, reason: "selling their own services" },
  { pattern: /\b(?:taking on|accepting)\s+(?:new\s+)?(?:clients?|work|projects?)\b/i, reason: "selling their own services" },
  { pattern: /\b(?:looking|searching)\s+for\s+(?:a\s+)?(?:job|gig|work|role|position|employment)\b/i, reason: "looking for work, not for a supplier" },
  { pattern: /\b(?:#)?(?:opentowork|forhire|hireme)\b/i, reason: "selling their own services" },
];

/**
 * Language that means the speaker can actually authorise a purchase.
 *
 * The distinction the tiers alone miss: "I wish we had a better X" and "we are
 * evaluating X this quarter" express the same want, and only one of them comes
 * from somebody who can sign. Plural first person is the cheapest reliable
 * marker — people speaking for an organisation say "we" — and an explicit
 * title is the strongest.
 */
const AUTHORITY: Array<{ pattern: RegExp; weight: number; label: string }> = [
  {
    pattern: /\b(?:i(?:'m| am)\s+(?:the\s+)?(?:cto|ceo|coo|cio|ciso|founder|co-?founder|owner|director|vp|head of|manager|lead))\b/i,
    weight: 20,
    label: "states a decision-making role",
  },
  {
    pattern: /\b(?:my|our)\s+(?:team|company|org(?:ani[sz]ation)?|firm|agency|startup|department)\b/i,
    weight: 12,
    label: "speaking for an organisation",
  },
  {
    pattern: /\b(?:we(?:'re| are)?\s+(?:evaluating|assessing|comparing|shortlisting|reviewing|procuring|rolling out|standardi[sz]ing))\b/i,
    weight: 18,
    label: "running a buying process",
  },
  {
    pattern: /\b(?:we|our team)\s+(?:need|want|require|use|are using|have decided|plan to)\b/i,
    weight: 10,
    label: "buying on behalf of a team",
  },
  {
    pattern: /\b(?:sign(?:ing)? off|approve[ds]?|procurement|purchase order|vendor review|security review)\b/i,
    weight: 15,
    label: "purchasing process language",
  },
];

/** How much authority language the text shows, capped. */
export function authorityBonus(text: string): { bonus: number; reasons: string[] } {
  let bonus = 0;
  const reasons: string[] = [];
  for (const a of AUTHORITY) {
    if (a.pattern.test(text)) {
      bonus += a.weight;
      reasons.push(a.label);
    }
  }
  // Capped: stacking every marker should not outweigh the fact of asking.
  return { bonus: Math.min(30, bonus), reasons };
}

export type IntentSignal = {
  /** 0–100, recency already applied. */
  score: number;
  tier: IntentTier;
  /** Why it scored what it did, in the user's words where possible. */
  reasons: string[];
  /** Set when the text rules the lead out entirely. */
  disqualified: string | null;
  /** Age in hours, or null when the source gave no timestamp. */
  ageHours: number | null;
  /**
   * Whether the speaker showed signs of being able to authorise a purchase.
   * False is not disqualifying — plenty of real buyers write tersely — but it
   * is the difference between a lead and a bystander with the same question.
   */
  decisionMaker: boolean;
  /**
   * Which path put this on topic. Null means the keyword path found nothing
   * and a description judgement has not been made yet — never that the signal
   * is off-topic, which is what `disqualified` is for.
   */
  matchPath: "keyword" | "description" | null;
};

/**
 * How much of a signal's strength survives its age.
 *
 * Halves every HALF_LIFE_HOURS rather than falling off a cliff at some
 * threshold, because a 25-hour-old post is not meaningfully worse than a
 * 23-hour-old one and a step function would rank them as if it were.
 */
export function recencyFactor(ageHours: number | null): number {
  // No timestamp is not the same as old. Most scraped directory entries have
  // no date at all, and pretending they are fresh would rank them above a
  // real post from yesterday — so they take a flat penalty instead.
  if (ageHours === null) return 0.55;
  if (ageHours < 0) return 1;
  if (ageHours > MAX_AGE_HOURS) return 0;
  return Math.pow(0.5, ageHours / HALF_LIFE_HOURS);
}

/**
 * Score a piece of public text for buying intent.
 *
 * `keywords` are the campaign's own topic words. Intent without topic match is
 * somebody else's lead: "anyone recommend a good accountant" is a perfect
 * solicitation and worthless to a company selling load testing.
 */
export function scoreIntent(input: {
  text: string;
  /** When it was posted. Null when the source does not say. */
  postedAt?: Date | null;
  /** Campaign topic words. At least one must appear. */
  keywords?: string[];
  negativeKeywords?: string[];
  /**
   * Let a signal survive a keyword miss so a description judgement can decide.
   * Off by default: without somewhere to send the survivors this would simply
   * widen the funnel.
   */
  allowDescriptionMatch?: boolean;
  now?: Date;
}): IntentSignal {
  const text = (input.text ?? "").slice(0, 8000);
  const now = input.now ?? new Date();
  const ageHours = input.postedAt
    ? Math.max(0, (now.getTime() - input.postedAt.getTime()) / 3_600_000)
    : null;

  const base: IntentSignal = {
    score: 0,
    tier: "none",
    reasons: [],
    disqualified: null,
    ageHours,
    decisionMaker: false,
    matchPath: null,
  };
  if (!text.trim()) return { ...base, disqualified: "no text to read" };

  for (const d of DISQUALIFIERS) {
    if (d.pattern.test(text)) return { ...base, disqualified: d.reason };
  }

  const negatives = (input.negativeKeywords ?? []).filter((k) =>
    k.trim() ? text.toLowerCase().includes(k.toLowerCase()) : false,
  );
  if (negatives.length) {
    return { ...base, disqualified: `negative match: ${negatives.join(", ")}` };
  }

  const keywords = (input.keywords ?? []).filter((k) => k.trim());
  if (keywords.length) {
    const hits = keywords.filter((k) => text.toLowerCase().includes(k.toLowerCase()));
    if (hits.length) {
      base.matchPath = "keyword";
      base.reasons.push(`mentions ${hits.slice(0, 3).join(", ")}`);
    } else if (!input.allowDescriptionMatch) {
      return { ...base, disqualified: "on-topic for nobody — no campaign keyword appears" };
    }
    // With a description to judge against, a keyword miss is not a verdict.
    // The people worth reaching describe their problem, not the product
    // category that solves it, so the best requests avoid the campaign's
    // vocabulary by construction. matchPath stays null for the caller to
    // resolve.
  }

  const matched = TIERS.filter((t) => t.patterns.some((p) => p.test(text)));
  if (!matched.length) {
    return {
      ...base,
      score: 0,
      tier: "none",
      disqualified: null,
      reasons: [...base.reasons, "no expression of intent — nobody asked for anything"],
      matchPath: base.matchPath,
    };
  }

  // The strongest statement sets the score; the others add a little, because
  // someone who is both leaving a supplier and asking for recommendations is
  // a better prospect than someone doing either alone — but not twice as good.
  const strongest = matched[0];
  const extra = matched.slice(1).reduce((n, t) => n + t.weight * 0.08, 0);
  // Authority is added to the ask, not multiplied by it. Someone who can sign
  // but has not asked for anything is still not a lead — the bonus should
  // promote a buyer above a bystander who asked the same question, not
  // manufacture intent out of a job title.
  const authority = authorityBonus(text);
  const raw = Math.min(100, strongest.weight + extra + authority.bonus);

  const factor = recencyFactor(ageHours);
  const reasons = [...base.reasons, strongest.label];
  for (const t of matched.slice(1)) reasons.push(t.label);
  for (const r of authority.reasons) reasons.push(r);

  if (ageHours === null) {
    reasons.push("no date on the source, so treated as stale");
  } else if (ageHours <= 6) {
    reasons.push("posted in the last few hours");
  } else if (ageHours <= 24) {
    reasons.push("posted today");
  } else {
    reasons.push(`${Math.round(ageHours / 24)}d old`);
  }

  return {
    score: Math.round(raw * factor),
    tier: strongest.tier,
    reasons,
    disqualified: factor === 0 ? `older than ${Math.round(MAX_AGE_HOURS / 24)} days` : null,
    ageHours,
    decisionMaker: authority.bonus > 0,
    matchPath: base.matchPath,
  };
}

/**
 * Default bar for acting on a signal.
 *
 * Chosen from the measured spread rather than picked round. At 72-hour
 * half-life a day-old "can anyone recommend a X" scores 56 and a fresh
 * unattributed grumble scores 42, and 50 sits in the gap between them: real
 * requests stay in for about three days, complaints from nobody in particular
 * never get in. A team lead saying "our team is struggling with X" clears it
 * at 54, because that is a lead and a stranger's grumble is not.
 */
export const DEFAULT_MIN_INTENT = 50;

/**
 * Whether a lead clears a campaign's bar.
 *
 * A campaign with no bar set keeps the old behaviour, so turning intent
 * scoring on does not silently empty anybody's pipeline.
 */
export function qualifies(signal: IntentSignal, minIntent: number | null | undefined): boolean {
  if (signal.disqualified) return false;
  if (minIntent === null || minIntent === undefined) return true;
  return signal.score >= minIntent;
}

/** One-line explanation for the run log and the leads table. */
export function describeIntent(signal: IntentSignal): string {
  if (signal.disqualified) return `no intent: ${signal.disqualified}`;
  if (signal.tier === "none") return "no intent signal";
  return `${signal.score}/100 ${signal.tier} — ${signal.reasons.slice(0, 3).join("; ")}`;
}
