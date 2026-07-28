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

/** Hours after which a signal has decayed to roughly half its strength. */
const HALF_LIFE_HOURS = 36;
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
      /\b(?:hire|hiring|contract|engage)\s+(?:someone|a\s+\w+|an\s+agency|a\s+freelancer)\b/i,
      /\bpaid\s+(?:tool|service|plan|option|solution)\b/i,
      /\bhappy\s+to\s+(?:pay|spend)\b/i,
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
];

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
  now?: Date;
}): IntentSignal {
  const text = (input.text ?? "").slice(0, 8000);
  const now = input.now ?? new Date();
  const ageHours = input.postedAt
    ? Math.max(0, (now.getTime() - input.postedAt.getTime()) / 3_600_000)
    : null;

  const base: IntentSignal = { score: 0, tier: "none", reasons: [], disqualified: null, ageHours };
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
    if (!hits.length) {
      return { ...base, disqualified: "on-topic for nobody — no campaign keyword appears" };
    }
    base.reasons.push(`mentions ${hits.slice(0, 3).join(", ")}`);
  }

  const matched = TIERS.filter((t) => t.patterns.some((p) => p.test(text)));
  if (!matched.length) {
    return {
      ...base,
      score: 0,
      tier: "none",
      disqualified: null,
      reasons: [...base.reasons, "no expression of intent — nobody asked for anything"],
    };
  }

  // The strongest statement sets the score; the others add a little, because
  // someone who is both leaving a supplier and asking for recommendations is
  // a better prospect than someone doing either alone — but not twice as good.
  const strongest = matched[0];
  const extra = matched.slice(1).reduce((n, t) => n + t.weight * 0.08, 0);
  const raw = Math.min(100, strongest.weight + extra);

  const factor = recencyFactor(ageHours);
  const reasons = [...base.reasons, strongest.label];
  for (const t of matched.slice(1)) reasons.push(t.label);

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
  };
}

/** Default bar for acting on a signal. Roughly "a fresh solicitation". */
export const DEFAULT_MIN_INTENT = 40;

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
