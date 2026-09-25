// The row that makes a break measurable.
//
// serveAd decides *what* plays and meters the fill. A decision records that
// answer as something a player can report against: the beacons that follow
// carry a decision id, not a creative id, because two breaks in one session
// can show the same creative and "which play was this" is the question the
// funnel has to answer.
//
// Writing one must never cost the listener a break. Every function here
// returns null instead of throwing, and the serving path treats a null
// decision as "measurement is off for this one" and serves the ad anyway. The
// alternative — failing the break because we could not record it — trades a
// working ad for a statistic.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Fill } from "@/lib/ads/serve";
import type { StreamKind } from "./serve";

/** How long a decision stays answerable for its session. */
const DECISION_TTL_MS = 30 * 60 * 1000;

/** Surfaces the schema will accept. Anything else is recorded as web. */
const SURFACES = new Set(["web", "pwa", "desktop", "cli", "tui", "headless"]);

export function normalizeSurface(v: string | null | undefined): string {
  return v && SURFACES.has(v) ? v : "web";
}

/**
 * Placements are open-ended in the schema (`text not null default 'preroll'`)
 * but the per-session uniqueness rule keys on them, so an unbounded value from
 * a query string would let a client mint unlimited pre-rolls for one session
 * by varying it. The list is what we actually serve.
 */
const PLACEMENTS = new Set(["preroll", "midroll", "postroll"]);

export function normalizePlacement(v: string | null | undefined): string {
  return v && PLACEMENTS.has(v) ? v : "preroll";
}

export type DecisionRow = {
  id: string;
  creative_id: string | null;
  campaign_id: string | null;
  result: string;
  destination_url: string | null;
  impression_id: string | null;
  presentation_kind: string;
};

/**
 * The decision this session already has, if it has one.
 *
 * This is the whole one-ad-per-session rule, and checking it *before* serveAd
 * is what makes it true: a player that remounts, reconnects or retries would
 * otherwise be metered again for an ad it is about to be shown for the second
 * time. An expired decision is ignored — a session idle for half an hour is a
 * new listen, not a retry.
 */
export async function existingDecision(
  sb: SupabaseClient,
  args: { slotId: string; sessionId: string; placement: string },
): Promise<DecisionRow | null> {
  const { data } = await sb
    .from("ad_video_decisions")
    .select("id, creative_id, campaign_id, result, destination_url, impression_id, presentation_kind")
    .eq("slot_id", args.slotId)
    .eq("playback_session_id", args.sessionId)
    .eq("placement", args.placement)
    .is("property_id", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return (data as DecisionRow | null) ?? null;
}

export type RecordDecisionInput = {
  slotId: string;
  sessionId: string;
  placement: string;
  kind: StreamKind;
  surface: string;
  /** Null when no campaign wanted the break at all. */
  fill: Fill | null;
  /** Null when a creative won but has no playable media. */
  assetRevision: number | null;
  reason?: string | null;
};

/**
 * Record what was served, and return the id a player reports against.
 *
 * Returns null on any failure, including the race where two requests for one
 * session arrive together — the loser reads the winner's row rather than
 * inventing a second decision for the same play.
 */
export async function recordDecision(
  sb: SupabaseClient,
  input: RecordDecisionInput,
): Promise<string | null> {
  const { fill } = input;
  const house = fill?.tier === "house";
  const result = !fill ? "no_ad" : house ? "house" : "ad";

  const row: Record<string, unknown> = {
    property_id: null,
    slot_id: input.slotId,
    playback_session_id: input.sessionId,
    placement: input.placement,
    // A house fill carries the literal ids "house", which are not rows; the
    // foreign keys would reject them and the tier already says what it was.
    campaign_id: house || !fill ? null : fill.campaignId,
    creative_id: house || !fill ? null : fill.creativeId,
    asset_revision: input.assetRevision,
    result,
    reason: input.reason ?? null,
    delivery: fill ? "client_mp4" : null,
    presentation_kind: input.kind,
    surface: normalizeSurface(input.surface),
    tier: fill?.tier ?? null,
    // Pinned at decision time: editing a campaign's URL afterwards must not
    // redirect a listener who was shown the old claim somewhere else.
    destination_url: fill?.clickUrl ?? null,
    // House fills are never metered, so they have no impression to point at.
    impression_id: house || !fill ? null : fill.impressionId,
    expires_at: new Date(Date.now() + DECISION_TTL_MS).toISOString(),
  };

  const { data, error } = await sb
    .from("ad_video_decisions")
    .insert(row)
    .select("id")
    .maybeSingle();

  if (!error && data?.id) return data.id as string;

  // serveAd hands back a synthesised impression id when its own insert failed,
  // so the foreign key can reject a row that is otherwise fine. Measurement
  // without the ledger link is worth more than no measurement.
  if (error?.code === "23503" && row.impression_id) {
    const retry = await sb
      .from("ad_video_decisions")
      .insert({ ...row, impression_id: null })
      .select("id")
      .maybeSingle();
    if (retry.data?.id) return retry.data.id as string;
    return null;
  }

  // Lost the per-session race: the other request's decision is the right one
  // to report against.
  if (error?.code === "23505") {
    const existing = await existingDecision(sb, {
      slotId: input.slotId,
      sessionId: input.sessionId,
      placement: input.placement,
    });
    return existing?.id ?? null;
  }

  // Everything else is swallowed — a break must never fail because we could
  // not measure it — but it is said out loud, because a silent one looks
  // exactly like no traffic.
  //
  // The failure this has actually produced: PostgREST caches the schema, and
  // migrations here are applied by hand, so the deploy after one that adds a
  // column answers PGRST204 ("Could not find the 'tier' column … in the schema
  // cache") for every insert naming it. Nothing about the database is wrong;
  // it needs `notify pgrst, 'reload schema'`. Recording zero decisions while
  // happily serving ads is how that presents.
  console.warn(
    `[ads] video decision not recorded for slot ${input.slotId}: ${error?.code ?? "unknown"} ${
      (error as { message?: string } | null)?.message ?? ""
    }`,
  );
  return null;
}
