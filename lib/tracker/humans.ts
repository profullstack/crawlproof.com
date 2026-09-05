// The one place that says what "human" means on the analytics pages.
//
// WHY: the dashboards used to lead with a bot-inclusive total. On one property
// 99% of ~257k weekly hits were a single AI training crawler, and the card was
// read as "80k pageviews a day" for a site with a few hundred real readers.
// Every headline now leads with humans and shows bot crawls separately, and
// every number that gets labelled points at these strings so the definition
// is the same wherever it is shown.
//
// Definition (mirrored in supabase/migrations/20260905120000_tracker_human_split.sql):
//   human = bucket does NOT start with "bot:"  (ai_referral / search / social /
//           referral / human:direct — a person arriving from ChatGPT is a person)
//   bot   = bucket starts with "bot:"          (named AI crawlers + bot:other)
// so humans + bots = events, exactly.

export const HUMANS_LABEL = "Human visits";
export const BOTS_LABEL = "Bot crawls";

export const HUMANS_DEFINITION =
  "Everything not identified as a crawler, including visits referred by AI assistants such as ChatGPT or Perplexity.";

export const BOTS_DEFINITION =
  "Hits from user agents identified as crawlers: AI training and retrieval bots, search engine bots, and other automated clients. Not people.";

export const AI_REFERRALS_DEFINITION =
  "People who arrived from an AI assistant. These are already counted inside human visits.";

export const ALL_EVENTS_DEFINITION =
  "Every tracked event, human and bot together. This is the old headline number; bots can dominate it.";

type Countable = number | string | null | undefined;

/** Coerce a PostgREST count (bigint columns arrive as strings). null when absent. */
export function toCount(value: Countable): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Humans for one RPC row. Prefers the `humans` column the split migration
 * adds; before it is applied the column is missing, and the identity
 * humans = events - bots is exact for every bucket-based leg, so fall back to
 * that rather than to zero (a dashboard that says "0 human visits" while the
 * bot column climbs is the misreading this exists to prevent, mirrored).
 */
export function humansFrom(row: {
  humans?: Countable;
  events: Countable;
  bots: Countable;
}): number {
  const explicit = toCount(row.humans);
  if (explicit !== null) return explicit;
  return Math.max(0, (toCount(row.events) ?? 0) - (toCount(row.bots) ?? 0));
}
