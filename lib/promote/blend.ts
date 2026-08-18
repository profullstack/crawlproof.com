// Blend selection: deciding whether the next post draws from the user's own
// content or from shared content.
//
// Random selection weighted 70/30 does not give you 70/30. Over the handful of
// posts a drip campaign makes in a day it gives you streaks, and a streak of
// shared content is exactly what makes an automated account look like a
// content farm. So selection is deficit-based instead: on every tick the class
// furthest *below* its target share is the one that posts. Over a rolling
// window that converges on the configured ratio, and it never produces a run
// of one class while the other sits starved.
//
// This module is pure. The database side lives in lib/promote/selectLink.ts.

export type Ownership = "owned" | "partner" | "shared";

export const OWNERSHIPS: readonly Ownership[] = ["owned", "partner", "shared"] as const;

export type BlendMix = Record<Ownership, number>;

export type FallbackAction = "pause" | "use_shared" | "use_owned" | "use_any_available";

export type FallbackPolicy = {
  whenOwnedQueueEmpty: FallbackAction;
  whenSharedQueueEmpty: FallbackAction;
  maxFallbackItemsPerDay: number | null;
};

export const DEFAULT_MIX: BlendMix = { owned: 70, partner: 0, shared: 30 };

export const DEFAULT_FALLBACK: FallbackPolicy = {
  whenOwnedQueueEmpty: "use_shared",
  whenSharedQueueEmpty: "use_owned",
  maxFallbackItemsPerDay: 3,
};

/** Read a stored source_mix, falling back to the default on anything unusable. */
export function parseMix(raw: unknown): BlendMix {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MIX };
  const source = raw as Record<string, unknown>;
  const mix: BlendMix = { owned: 0, partner: 0, shared: 0 };
  let total = 0;
  for (const key of OWNERSHIPS) {
    const value = Number(source[key]);
    const weight = Number.isFinite(value) && value > 0 ? value : 0;
    mix[key] = weight;
    total += weight;
  }
  // A mix that weights nothing would post nothing.
  return total > 0 ? mix : { ...DEFAULT_MIX };
}

/** Read a stored fallback_policy, falling back to the default per field. */
export function parseFallback(raw: unknown): FallbackPolicy {
  const source = (raw ?? {}) as Record<string, unknown>;
  const action = (value: unknown, fallback: FallbackAction): FallbackAction =>
    value === "pause" ||
    value === "use_shared" ||
    value === "use_owned" ||
    value === "use_any_available"
      ? value
      : fallback;

  const cap = source.maxFallbackItemsPerDay;
  return {
    whenOwnedQueueEmpty: action(
      source.whenOwnedQueueEmpty,
      DEFAULT_FALLBACK.whenOwnedQueueEmpty,
    ),
    whenSharedQueueEmpty: action(
      source.whenSharedQueueEmpty,
      DEFAULT_FALLBACK.whenSharedQueueEmpty,
    ),
    maxFallbackItemsPerDay:
      cap === null ? null : Number.isFinite(Number(cap)) ? Number(cap) : DEFAULT_FALLBACK.maxFallbackItemsPerDay,
  };
}

export type BlendDecision = {
  /** The class to draw the next link from, or null when nothing may post. */
  ownership: Ownership | null;
  /** True when the target class was empty and another one covered for it. */
  viaFallback: boolean;
  /** Why, for the history view and for debugging a stalled list. */
  reason:
    | "on_target"
    | "fallback"
    | "no_inventory"
    | "fallback_disabled"
    | "fallback_cap_reached";
};

export type BlendInput = {
  mix: BlendMix;
  /** Posts per ownership class over the rolling window. */
  posted: Partial<Record<Ownership, number>>;
  /** Which classes have a link ready to post right now. */
  available: Partial<Record<Ownership, boolean>>;
  /**
   * Which classes the campaign has an enabled source feeding. A class with no
   * inventory *and* no source is not starved — the campaign simply does not
   * publish that kind of content.
   */
  hasSource?: Partial<Record<Ownership, boolean>>;
  fallback: FallbackPolicy;
  /** Fallback posts already made today, against maxFallbackItemsPerDay. */
  fallbackUsedToday?: number;
};

/**
 * Narrow a mix to the classes this campaign can actually supply.
 *
 * Without this, a campaign of nothing but the user's own pasted links reads its
 * 70/30 default as "30% short on shared content", finds none, and posts its own
 * links as *fallbacks* — every tick, until maxFallbackItemsPerDay stops the
 * campaign dead. A class the campaign has no inventory and no source for is not
 * a starved class; it is not part of this campaign's mix at all.
 *
 * Returns the original mix when nothing qualifies, so the caller still gets a
 * ranking to reason about rather than an empty one.
 */
export function effectiveMix(
  mix: BlendMix,
  available: Partial<Record<Ownership, boolean>>,
  hasSource: Partial<Record<Ownership, boolean>> = {},
): BlendMix {
  const restricted: BlendMix = { owned: 0, partner: 0, shared: 0 };
  let total = 0;
  for (const key of OWNERSHIPS) {
    if (mix[key] <= 0) continue;
    if (!available[key] && !hasSource[key]) continue;
    restricted[key] = mix[key];
    total += mix[key];
  }
  return total > 0 ? restricted : mix;
}

/**
 * Rank the ownership classes by how far each is below its target share.
 * Exported for the preview UI, which shows why a given item is next.
 */
export function rankByDeficit(mix: BlendMix, posted: Partial<Record<Ownership, number>>): Ownership[] {
  const totalWeight = OWNERSHIPS.reduce((sum, key) => sum + mix[key], 0);
  const totalPosted = OWNERSHIPS.reduce((sum, key) => sum + (posted[key] ?? 0), 0);

  return OWNERSHIPS.filter((key) => mix[key] > 0)
    .map((key) => {
      const target = mix[key] / totalWeight;
      const actual = totalPosted === 0 ? 0 : (posted[key] ?? 0) / totalPosted;
      return { key, deficit: target - actual, weight: mix[key] };
    })
    // Largest deficit first; ties break toward the heavier weight so a fresh
    // list opens with its dominant class rather than by object key order.
    .sort((a, b) => b.deficit - a.deficit || b.weight - a.weight)
    .map((entry) => entry.key);
}

/**
 * Choose which ownership class the next post draws from.
 */
export function chooseOwnership(input: BlendInput): BlendDecision {
  const { posted, available, fallback } = input;
  const mix = effectiveMix(input.mix, available, input.hasSource);
  const ranked = rankByDeficit(mix, posted);

  // The class that is furthest behind and actually has something to post.
  const target = ranked[0];
  if (!target) return { ownership: null, viaFallback: false, reason: "no_inventory" };
  if (available[target]) {
    return { ownership: target, viaFallback: false, reason: "on_target" };
  }

  // The target is starved. What the campaign is allowed to do about it depends
  // on which side ran dry.
  const action: FallbackAction =
    target === "owned"
      ? fallback.whenOwnedQueueEmpty
      : target === "shared"
        ? fallback.whenSharedQueueEmpty
        : "use_any_available";

  if (action === "pause") {
    return { ownership: null, viaFallback: false, reason: "fallback_disabled" };
  }

  const preferred: Ownership[] =
    action === "use_shared"
      ? ["shared"]
      : action === "use_owned"
        ? ["owned"]
        : ranked.filter((key) => key !== target);

  // "use_any_available" also considers classes with zero weight — a list mixed
  // 100/0 still has partner links it may fall back to.
  const candidates =
    action === "use_any_available"
      ? [...preferred, ...OWNERSHIPS.filter((key) => key !== target && !preferred.includes(key))]
      : preferred;

  const replacement = candidates.find((key) => available[key]);
  if (!replacement) {
    return { ownership: null, viaFallback: false, reason: "no_inventory" };
  }

  // The cap is what stops a user with no original content from turning into an
  // uncontrolled shared-content firehose.
  const cap = fallback.maxFallbackItemsPerDay;
  if (cap !== null && (input.fallbackUsedToday ?? 0) >= cap) {
    return { ownership: null, viaFallback: false, reason: "fallback_cap_reached" };
  }

  return { ownership: replacement, viaFallback: true, reason: "fallback" };
}
