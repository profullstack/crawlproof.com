// The immutable input to a render, and the hash that dedupes it.
//
// A render job is expensive and perfectly deterministic: the same snapshot, the
// same renderer, the same profile always produce the same bytes. So the job is
// keyed by a hash of everything that can change the output, and an unchanged
// design reuses the encode that already exists instead of burning a worker on
// it again.

import { createHash } from "node:crypto";
import type { VideoProfileId } from "./profiles";

/**
 * Bump when the compositor's output changes for unchanged input.
 *
 * This is part of the hash, which is the whole point: a change to the timeline,
 * the type scale, or the safe area must invalidate every cached render, and
 * without a version in the key a fixed compositor would keep serving the old
 * bytes forever. Bumping it is the deliberate cost of changing the look.
 */
export const RENDERER_VERSION = "1";

export type AudioMode = "silent" | "narrated";

/**
 * Everything the compositor is allowed to read.
 *
 * Deliberately flat and primitive. A snapshot is stored as JSON, hashed, and
 * replayed weeks later by a worker that cannot re-fetch anything — so it holds
 * resolved values, not references. `logoSha256`/`heroSha256` are the *content*
 * hashes of the source artwork rather than its URLs, because the same URL can
 * serve different bytes and a cache keyed on the URL would then reuse a render
 * of artwork the advertiser has since replaced.
 */
export type VideoDesignSnapshot = {
  headline: string;
  ctaText: string;
  /** Bare host, e.g. "nichedb.dev" — shown as the destination, never a full URL. */
  domain: string;
  bgColor: string;
  fgColor: string;
  accentColor: string;
  fontFamily: string;
  logoUrl: string | null;
  logoSha256: string | null;
  heroUrl: string | null;
  heroSha256: string | null;
  audioMode: AudioMode;
  /** Narration script, when audioMode is "narrated". Drives the captions too. */
  narration: string | null;
  locale: string;
  /** Static composition over the same five-second timeline. */
  reducedMotion: boolean;
};

/**
 * Canonical JSON: keys sorted at every level, no incidental whitespace.
 *
 * JSON.stringify preserves insertion order, so two snapshots that differ only
 * in the order their fields were assigned would otherwise hash differently and
 * re-render identical bytes. Sorting makes the hash a function of the content.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // Undefined members are absent, not null: an explicitly-undefined field and
    // a missing one describe the same design and must hash the same.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * The dedupe key for one output of one design.
 *
 * Profile is part of the key rather than a separate column lookup because the
 * 720p and 480p renditions of the same snapshot are different bytes with
 * different budgets, and a single key across both would let one satisfy the
 * other.
 */
export function renderHash(snapshot: VideoDesignSnapshot, profile: VideoProfileId): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        v: RENDERER_VERSION,
        profile,
        snapshot,
      }),
    )
    .digest("hex");
}

/** Content hash of a source asset, for the snapshot's *Sha256 fields. */
export function assetHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Headline length guard.
 *
 * Eight words is the spec's target, but the real constraint is that the
 * headline has to be legible at the 480p rendition's height for the roughly
 * three seconds it holds. Measured layout happens in the compositor; this is
 * the cheap check that runs before a worker is spent on it.
 */
export const MAX_HEADLINE_WORDS = 8;

export function headlineWords(headline: string): number {
  return headline.trim().split(/\s+/).filter(Boolean).length;
}

export type SnapshotProblem = { field: string; reason: string };

/**
 * Reject a snapshot that cannot produce a legible ad, before it costs a render.
 *
 * Returns every problem rather than the first, so the dashboard can show an
 * advertiser all of what needs fixing in one pass instead of one per attempt.
 */
export function validateSnapshot(s: VideoDesignSnapshot): SnapshotProblem[] {
  const problems: SnapshotProblem[] = [];
  const hex = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

  if (!s.headline.trim()) {
    problems.push({ field: "headline", reason: "empty" });
  } else if (headlineWords(s.headline) > MAX_HEADLINE_WORDS) {
    problems.push({
      field: "headline",
      reason: `${headlineWords(s.headline)} words, max ${MAX_HEADLINE_WORDS}`,
    });
  }

  if (!s.ctaText.trim()) problems.push({ field: "ctaText", reason: "empty" });
  if (!s.domain.trim()) problems.push({ field: "domain", reason: "empty" });

  for (const [field, value] of [
    ["bgColor", s.bgColor],
    ["fgColor", s.fgColor],
    ["accentColor", s.accentColor],
  ] as const) {
    if (!hex.test(value)) problems.push({ field, reason: "not a hex colour" });
  }

  // A narrated ad with no script would render five seconds of silence and be
  // recorded as an audible companion, which is the failure the spec calls out
  // by name: silence is never an audio ad.
  if (s.audioMode === "narrated" && !s.narration?.trim()) {
    problems.push({ field: "narration", reason: "narrated but no script" });
  }
  if (s.audioMode === "silent" && s.narration?.trim()) {
    problems.push({ field: "narration", reason: "script present but audioMode is silent" });
  }

  return problems;
}
