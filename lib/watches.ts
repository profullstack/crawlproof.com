// "Watch this URL" — the recurring lead capture behind M2 of the lead engine.
//
// The report on /r/<token> stays fully public; what asks for an email is the
// ONGOING relationship. Somebody who wants a weekly re-scan of a site is, by
// definition, the person responsible for that site — the request is the
// qualification, so no scoring model is needed.
//
// The decision logic lives here as pure functions because it is the part with
// real branching (two engines whose scores move in opposite directions) and
// the part that must not send a wrong or noisy email.

import { buildShareCard, type ShareCardAudit } from "@/lib/audit/share-card";

export const WATCH_CADENCES = ["weekly", "monthly"] as const;
export type WatchCadence = (typeof WATCH_CADENCES)[number];

/** Engines a watch may re-run. Both are free and self-hosted, so a watch can
 *  never turn into recurring LLM spend on an address we never charged. */
export const WATCH_ENGINES = ["rule", "slop"] as const;
export type WatchEngine = (typeof WATCH_ENGINES)[number];

/**
 * Scores wobble by a point between runs (a page times out, a nav link
 * changes). Mailing somebody about a 1-point flap trains them to ignore us,
 * which costs more than the missed signal. Two points is the smallest change
 * that is reliably real.
 */
export const WATCH_MIN_DELTA = 2;

/** A watch is a standing promise to email; an unbounded list per address is a
 *  free monitoring tier and a spam vector. */
export const MAX_WATCHES_PER_EMAIL = 10;

export function normalizeWatchEmail(email: string): string | null {
  const e = email.trim().toLowerCase();
  // Deliberately loose — real validation is the confirmation email, which is
  // the only thing that proves the address wants this.
  if (!e || e.length > 254 || !e.includes("@") || /\s/.test(e)) return null;
  const [local, domain, ...rest] = e.split("@");
  if (rest.length > 0 || !local || !domain || !domain.includes(".")) return null;
  return e;
}

export function isWatchCadence(v: unknown): v is WatchCadence {
  return typeof v === "string" && (WATCH_CADENCES as readonly string[]).includes(v);
}

export function isWatchEngine(v: unknown): v is WatchEngine {
  return typeof v === "string" && (WATCH_ENGINES as readonly string[]).includes(v);
}

export function nextRunAt(cadence: WatchCadence, from: Date): Date {
  const days = cadence === "weekly" ? 7 : 30;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The number a watch tracks — the same one the share card shows, which for a
 * slop scan is `summary.slopScore` and NOT `audits.score`. Watching the wrong
 * column would email people about a number their report never displays.
 */
export function watchScoreOf(audit: ShareCardAudit): number | null {
  const card = buildShareCard(audit);
  return card.state === "complete" ? card.score : null;
}

export type WatchVerdict = {
  notify: boolean;
  /** "first" on the first completed scan; otherwise the direction of travel. */
  kind: "first" | "improved" | "worsened" | "unchanged";
  delta: number;
  /** True when the site got better, accounting for the inverted slop dial. */
  improved: boolean;
};

/**
 * Decide whether a completed re-scan is worth an email.
 *
 * The inversion matters more here than anywhere else in the codebase: a slop
 * score falling from 60 to 40 is GOOD NEWS, and an email saying "your score
 * dropped" would read as the opposite.
 */
export function watchVerdict(input: {
  engineKind: "aeo" | "slop";
  previousScore: number | null;
  nextScore: number;
  minDelta?: number;
}): WatchVerdict {
  const minDelta = input.minDelta ?? WATCH_MIN_DELTA;

  // First completed scan under the watch: always worth one email. It confirms
  // what we are watching and sets the baseline.
  if (input.previousScore === null) {
    return { notify: true, kind: "first", delta: 0, improved: false };
  }

  const delta = input.nextScore - input.previousScore;
  if (Math.abs(delta) < minDelta) {
    return { notify: false, kind: "unchanged", delta, improved: false };
  }

  // AEO: up is better. Slop: down is better (0 = pristine).
  const improved = input.engineKind === "slop" ? delta < 0 : delta > 0;
  return {
    notify: true,
    kind: improved ? "improved" : "worsened",
    delta,
    improved,
  };
}

/** Subject line for a change email — states the direction in plain words so
 *  the inverted slop dial is never left for the reader to work out. */
export function watchSubject(input: {
  host: string;
  label: string;
  score: number;
  verdict: WatchVerdict;
}): string {
  const { verdict } = input;
  if (verdict.kind === "first") {
    return `Now watching ${input.host} — ${input.label} ${input.score}/100`;
  }
  // The word carries the judgement; the sign reports the raw movement of the
  // number. Deriving the sign from `improved` instead would print "−4" for a
  // 4-point AEO gain, since the two run in opposite directions.
  const word = verdict.improved ? "improved" : "got worse";
  const sign = verdict.delta > 0 ? "+" : "−";
  return `${input.host} ${word} — ${input.label} ${input.score}/100 (${sign}${Math.abs(verdict.delta)} pts)`;
}
