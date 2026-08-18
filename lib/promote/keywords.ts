// Keyword sources: a user types "bitcoin" and gets the RSS Amplifier topic
// feed for it. One keyword is one source — several keywords never collapse
// into a single ambiguous URL.

export const RSSAMPLIFIER_BASE_URL = (
  process.env.RSSAMPLIFIER_BASE_URL ?? "https://rssamplifier.com"
).replace(/\/+$/, "");

// RSS Amplifier slugs its topics: "artificial intelligence" is served at
// /topics/artificial-intelligence, not /topics/artificial%20intelligence.
const MAX_SLUG_LENGTH = 80;

export type KeywordInput = {
  /** Identity: lowercase, hyphenated, safe to put in a path segment. */
  slug: string;
  /** What the user typed, tidied up. Shown in the UI. */
  label: string;
};

/**
 * Fold a raw keyword into an RSS Amplifier topic slug. Returns null when
 * nothing usable survives (empty input, or punctuation only).
 */
export function slugifyKeyword(raw: string): string | null {
  const slug = (raw ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || null;
}

/** Collapse runs of whitespace so the stored label is tidy. */
export function keywordLabel(raw: string): string {
  return (raw ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Parse a user-supplied keyword list. Splits on commas and newlines only —
 * never on spaces, because "artificial intelligence" is one keyword.
 * Deduplicates by slug, keeping the first label seen.
 */
export function parseKeywords(raw: string): KeywordInput[] {
  const out: KeywordInput[] = [];
  const seen = new Set<string>();
  for (const chunk of (raw ?? "").split(/[,\n\r]+/)) {
    const label = keywordLabel(chunk);
    if (!label) continue;
    const slug = slugifyKeyword(label);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, label });
  }
  return out;
}

/** The topic feed URL a keyword source polls. */
export function topicFeedUrl(slug: string, base: string = RSSAMPLIFIER_BASE_URL): string {
  return `${base.replace(/\/+$/, "")}/topics/${encodeURIComponent(slug)}.rss`;
}

/** The human-facing topic page, for "view source" links in the UI. */
export function topicPageUrl(slug: string, base: string = RSSAMPLIFIER_BASE_URL): string {
  return `${base.replace(/\/+$/, "")}/topics/${encodeURIComponent(slug)}`;
}
