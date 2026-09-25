// Reading the pre-roll funnel.
//
// The rates are derived here rather than in SQL so that every surface — the
// API, the CLI, the dashboard — divides the same way. There is one division
// worth being careful about and it is the reason this file exists at all:
//
//   completion rate is completes / STARTS, not completes / fills.
//
// A fill is an ad that was chosen. Dividing by it mixes "the listener watched
// all five seconds" with "the player never got a frame", and the resulting
// number drops when autoplay policy changes without anything about the ad
// changing at all. Fills are still reported, as their own column and as the
// start rate, because the ads that are chosen and never played are a real
// problem — just a different one.

import type { SupabaseClient } from "@supabase/supabase-js";

export type VideoFunnelRow = {
  campaignId: string;
  campaignName: string;
  fills: number;
  starts: number;
  firstQuartile: number;
  midpoint: number;
  thirdQuartile: number;
  completes: number;
  clicks: number;
  errors: number;
  abandons: number;
  playedMs: number;
  /** starts / fills — how often a chosen ad actually reached a first frame. */
  startRate: number;
  /** completes / starts — how often a played ad was watched to the end. */
  completionRate: number;
};

export type VideoSlotFunnelRow = {
  slotId: string;
  projectName: string;
  fills: number;
  houseFills: number;
  unfilled: number;
  starts: number;
  completes: number;
  clicks: number;
  errors: number;
  abandons: number;
  playedMs: number;
  startRate: number;
  completionRate: number;
};

const n = (v: unknown): number => {
  const num = Number(v ?? 0);
  return Number.isFinite(num) ? num : 0;
};

/** Zero when the denominator is zero, rather than NaN reaching a template. */
const rate = (num: number, den: number): number => (den > 0 ? num / den : 0);

export function videoFunnelRow(raw: Record<string, unknown>): VideoFunnelRow {
  const fills = n(raw.fills);
  const starts = n(raw.starts);
  const completes = n(raw.completes);
  return {
    campaignId: String(raw.campaign_id ?? ""),
    campaignName: String(raw.campaign_name ?? ""),
    fills,
    starts,
    firstQuartile: n(raw.first_quartile),
    midpoint: n(raw.midpoint),
    thirdQuartile: n(raw.third_quartile),
    completes,
    clicks: n(raw.clicks),
    errors: n(raw.errors),
    abandons: n(raw.abandons),
    playedMs: n(raw.played_ms),
    startRate: rate(starts, fills),
    completionRate: rate(completes, starts),
  };
}

export function videoSlotFunnelRow(raw: Record<string, unknown>): VideoSlotFunnelRow {
  const fills = n(raw.fills);
  const starts = n(raw.starts);
  const completes = n(raw.completes);
  return {
    slotId: String(raw.slot_id ?? ""),
    projectName: String(raw.project_name ?? ""),
    fills,
    houseFills: n(raw.house_fills),
    unfilled: n(raw.unfilled),
    starts,
    completes,
    clicks: n(raw.clicks),
    errors: n(raw.errors),
    abandons: n(raw.abandons),
    playedMs: n(raw.played_ms),
    startRate: rate(starts, fills),
    completionRate: rate(completes, starts),
  };
}

/**
 * Campaign funnel for an owner, via the service-role core.
 *
 * Used by the bearer-token API and the CLI, where there is no auth.uid() for
 * the wrapper to read.
 */
export async function videoFunnelForOwner(
  sb: SupabaseClient,
  ownerId: string,
  days: number,
): Promise<VideoFunnelRow[]> {
  const { data, error } = await sb.rpc("ad_video_funnel_for", { p_owner: ownerId, p_days: days });
  if (error || !Array.isArray(data)) return [];
  return data.map((r) => videoFunnelRow(r as Record<string, unknown>));
}

export async function videoSlotFunnelForOwner(
  sb: SupabaseClient,
  ownerId: string,
  days: number,
): Promise<VideoSlotFunnelRow[]> {
  const { data, error } = await sb.rpc("ad_video_slot_funnel_for", {
    p_owner: ownerId,
    p_days: days,
  });
  if (error || !Array.isArray(data)) return [];
  return data.map((r) => videoSlotFunnelRow(r as Record<string, unknown>));
}

/** Campaign funnel for the signed-in user, via the auth.uid() wrapper. */
export async function videoFunnelForSession(
  sb: SupabaseClient,
  days: number,
): Promise<VideoFunnelRow[]> {
  const { data, error } = await sb.rpc("ad_video_funnel", { p_days: days });
  if (error || !Array.isArray(data)) return [];
  return data.map((r) => videoFunnelRow(r as Record<string, unknown>));
}

export async function videoSlotFunnelForSession(
  sb: SupabaseClient,
  days: number,
): Promise<VideoSlotFunnelRow[]> {
  const { data, error } = await sb.rpc("ad_video_slot_funnel", { p_days: days });
  if (error || !Array.isArray(data)) return [];
  return data.map((r) => videoSlotFunnelRow(r as Record<string, unknown>));
}

/** Window in days, clamped to something the funnel can answer cheaply. */
export function parseDays(v: string | null | undefined, fallback = 7): number {
  // Tested before the cast, because Number(null) and Number("") are both 0 —
  // finite, so a missing ?days= would clamp to a one-day window instead of
  // falling back to the default one.
  if (v === null || v === undefined || v.trim() === "") return fallback;
  const num = Number(v);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.round(num), 1), 365);
}
