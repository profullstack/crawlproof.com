// Deciding which subjects an autoblog writes about, and in what proportion.
//
// This module exists because of a specific failure, and the shape of it is a
// direct response to that failure. coinpayportal.com — a crypto payment
// processor — published nineteen consecutive articles about peptide vendors:
// "skye peptides", "pure peptide labs", "wolverine stack peptides". Those are
// competitor storefronts in an industry the site *serves*, not one it is in.
//
// Two independent defects produced it, and fixing either alone would have left
// the other running.
//
//   1. **Truncation.** The site had ten subjects. The pipeline sliced them to
//      five, then to three, and handed subject #1 to the buyer-journey model as
//      its entire query. Five subjects had never produced a keyword in the
//      site's lifetime. The top-up sweep re-ran the same truncated set every
//      time the queue drained, so the concentration compounded rather than
//      averaged out.
//
//   2. **An unanchored relevance gate.** A candidate was kept if it contained
//      the seed token. Expanding the bare word "peptide" against a keyword
//      tool returns the peptide industry's own vocabulary, and every one of
//      those passed a test that only ever asked "is this about peptides?" —
//      never "is this about what we sell to them?".
//
// The answer to both is the same: never expand a subject on its own. A subject
// is only ever researched *crossed with a modifier* — the tail terms that
// describe what this site actually does ("merchant account", "payment
// gateway"). "peptide" is not a topic. "peptide merchant account" is.
//
// That cross is also the floor. Every other source here can return nothing —
// the keyword API can be down, the model can refuse, the gate can reject
// everything — and the cross product still yields on-niche subjects, because
// it is built from two lists the operator controls rather than fetched. A
// blog that cannot reach any upstream still publishes, and still publishes
// about itself. Going dark and going off-topic are both failures; this
// prefers a smaller, correct queue to a full, spammy one.

/** Subjects past this point can't be given a meaningful share of a 30-row target. */
export const MAX_MASTERS = 12;

/**
 * Words that carry no topic and would pass any gate built on them.
 *
 * Deliberately not a general English stoplist: this is scoped to the words
 * that appear in a *niche description* and a keyword phrase without narrowing
 * either. "best" and "top" are here because they are the two most common
 * prefixes in keyword-tool output and matching on them would re-admit the
 * whole vendor-listicle class this module exists to reject.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "you", "your", "that", "this", "from", "into",
  "over", "but", "not", "are", "was", "were", "has", "had", "have", "its",
  "off", "out", "all", "any", "new", "get", "how", "why", "what", "who",
  "best", "top", "guide", "list", "using", "about", "when", "where", "which",
]);

/**
 * A token worth matching on.
 *
 * Four characters because three-letter fragments ("pay", "ads", "seo") match
 * inside unrelated words often enough to be worse than useless in a gate whose
 * entire job is rejecting near-misses.
 */
const MIN_TOKEN_LEN = 4;

/**
 * Split a phrase into matchable tokens.
 *
 * Punctuation is dropped rather than split on, so "high-risk" yields "high"
 * and "risk" — both of which are real narrowing terms for the site that wrote
 * that niche, and neither of which survives a naive whitespace split.
 */
export function tokens(phrase: string): string[] {
  return (phrase ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
}

/**
 * Reduce a token to a form that survives pluralisation.
 *
 * A crude suffix strip rather than a real stemmer, because the only job is
 * collapsing "payment"/"payments" and "transaction"/"transactions" so the
 * duplicate check can see that "peptide payments" and "peptide payment" are
 * the same article. A real stemmer would be a dependency and a behaviour
 * change in the gate, for a class of match this never needs to make.
 */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

/**
 * An order-independent fingerprint of what a keyword is about.
 *
 * Sorted, so "merchant account peptide" and "peptide merchant account" collide
 * — they would produce the same article, and a blog publishing both is the
 * duplicate-content problem this is here to prevent.
 */
export function signature(keyword: string): string {
  return Array.from(new Set(tokens(keyword).map(stem))).sort().join(" ");
}

type SiteTopicFields = {
  master_keywords?: string[] | null;
  seed_keywords?: string[] | null;
  modifiers?: string[] | null;
  niche?: string | null;
};

/**
 * The durable subject list for a site.
 *
 * Falls back to `seed_keywords` for any site the backfill has not reached, so
 * this is safe to deploy ahead of the migration rather than after it. Capped
 * on read as well as by the database constraint: a list that arrives oversized
 * from anywhere must still be allocated over, not rejected at publish time.
 */
export function resolveMasters(site: SiteTopicFields): string[] {
  const raw = (site.master_keywords?.length ? site.master_keywords : site.seed_keywords) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const trimmed = (entry ?? "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out.slice(0, MAX_MASTERS);
}

/**
 * The tail terms that anchor a subject to this site's own business.
 *
 * Thirteen of seventeen live sites have an empty `modifiers` column, so the
 * niche is mined for them rather than treating the empty case as
 * "no anchoring required" — that reading is precisely how an unanchored
 * expansion gets to run, and it is the thing being fixed. A site with neither
 * modifiers nor a niche gets an empty list, and `crossQueries` then declines
 * to produce anything, which surfaces as an actionable "set a niche" error
 * instead of silently publishing vendor listicles.
 */
export function resolveModifiers(site: SiteTopicFields): string[] {
  const explicit = (site.modifiers ?? [])
    .map((m) => (m ?? "").trim())
    .filter((m) => m.length > 0);
  if (explicit.length > 0) return explicit.slice(0, 20);
  return Array.from(new Set(tokens(site.niche ?? ""))).slice(0, 8);
}

/**
 * Every token that means "this keyword is about our business".
 *
 * The union of the modifiers and the niche, because the two are populated
 * inconsistently across live sites and a candidate matching either is anchored
 * in the sense the gate cares about.
 */
export function anchorTokens(site: SiteTopicFields): Set<string> {
  const out = new Set<string>();
  for (const modifier of resolveModifiers(site)) {
    for (const token of tokens(modifier)) out.add(stem(token));
  }
  for (const token of tokens(site.niche ?? "")) out.add(stem(token));
  return out;
}

/**
 * Is this candidate about one of our subjects *and* about what we do?
 *
 * Both halves are required, and that conjunction is the whole fix. The old
 * gate asked only the first question, which is why nineteen articles about
 * other people's peptide shops passed it.
 *
 * @param keyword the candidate
 * @param master the subject it was researched for
 * @param anchors from `anchorTokens`
 */
export function isOnNiche(
  keyword: string,
  master: string,
  anchors: Set<string>,
): boolean {
  const candidate = new Set(tokens(keyword).map(stem));
  if (candidate.size === 0) return false;

  const masterTokens = tokens(master).map(stem);
  const onSubject = masterTokens.length === 0
    ? true
    : masterTokens.some((t) => candidate.has(t));
  if (!onSubject) return false;

  // An anchorless site cannot answer the second question, and answering it
  // "yes" by default would restore the old behaviour exactly. Answering "no"
  // would empty every queue on the platform. Neither is acceptable, so the
  // caller is required to supply anchors and this asserts rather than guesses.
  if (anchors.size === 0) return false;

  for (const token of candidate) {
    if (anchors.has(token)) return true;
  }
  return false;
}

/**
 * The subjects to research, each already crossed with a narrowing term.
 *
 * Ordered subject-major — every subject's first cross comes before any
 * subject's second — so that a caller which runs out of API budget partway
 * through has still touched every subject rather than exhausting the first
 * one. That ordering is the difference between a budget cut costing depth and
 * costing coverage, and coverage is what was broken.
 *
 * A cross whose modifier tokens are already in the subject is skipped:
 * "crypto" × "crypto payments" would otherwise research "crypto crypto
 * payments".
 */
export function crossQueries(
  masters: string[],
  modifiers: string[],
  perMaster = 3,
): Array<{ master: string; query: string }> {
  const out: Array<{ master: string; query: string }> = [];
  if (masters.length === 0 || modifiers.length === 0) return out;

  const seen = new Set<string>();
  for (let depth = 0; depth < perMaster; depth += 1) {
    for (const master of masters) {
      const masterTokens = new Set(tokens(master).map(stem));
      // Each subject walks the modifier list from a different offset, so the
      // narrowing terms are spread across subjects instead of every subject
      // getting the same first modifier and the tail never being used.
      const offset = masters.indexOf(master);
      let taken = 0;
      for (let i = 0; i < modifiers.length && taken <= depth; i += 1) {
        const modifier = modifiers[(i + offset) % modifiers.length];
        if (tokens(modifier).every((t) => masterTokens.has(stem(t)))) continue;
        if (taken < depth) {
          taken += 1;
          continue;
        }
        const query = `${master} ${modifier}`.replace(/\s+/g, " ").trim();
        const key = signature(query);
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push({ master, query });
        }
        taken += 1;
      }
    }
  }
  return out;
}

/**
 * How many new keywords each subject should get.
 *
 * Fair share of the remaining target, but weighted toward whatever is *behind*
 * — a subject with no coverage is filled before one that already has twenty
 * articles. Without that, a queue topped up repeatedly stays in whatever
 * proportion it started in, and the site that published nineteen peptide posts
 * would go on publishing them at exactly the rate it always had.
 *
 * @param masters the subject list
 * @param coverage existing keyword count per subject (any status)
 * @param target how many rows to allocate in total
 */
export function allocate(
  masters: string[],
  coverage: Map<string, number>,
  target: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (masters.length === 0 || target <= 0) return out;

  for (const m of masters) out.set(m, 0);

  // Hand out one row at a time to whichever subject is furthest behind,
  // counting what has already been handed out in this pass. An O(target ×
  // masters) loop over at most 30 × 12, which is not worth a heap to avoid and
  // is far easier to prove correct than an apportionment formula.
  for (let i = 0; i < target; i += 1) {
    let pick = masters[0];
    let lowest = Infinity;
    for (const master of masters) {
      const total = (coverage.get(master.toLowerCase()) ?? 0) + (out.get(master) ?? 0);
      if (total < lowest) {
        lowest = total;
        pick = master;
      }
    }
    out.set(pick, (out.get(pick) ?? 0) + 1);
  }
  return out;
}

/**
 * Drop candidates that would produce an article the blog already has.
 *
 * Compares fingerprints rather than strings, so the pluralised and reordered
 * restatements of an existing post are caught. This is the direct answer to
 * "spamming blogs with same content": the old dedupe compared lowercased
 * keywords exactly, which let "peptide payments" and "peptide payment"
 * both through, and both were published — nine days apart, in May.
 *
 * @param candidates in preference order
 * @param published fingerprints already on the blog, from `signature`
 */
export function dropDuplicates<T extends { keyword: string }>(
  candidates: T[],
  published: Set<string>,
): T[] {
  const out: T[] = [];
  const seen = new Set(published);
  for (const candidate of candidates) {
    const key = signature(candidate.keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}
