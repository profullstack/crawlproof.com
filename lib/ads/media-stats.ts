// Reading the presentation rotation: how delivery split between media, and
// whether that split can be judged yet.
//
// The second half is the point. #316 rotates a slot between up to five media so
// that we can find out which one a size converts in, and the obvious report —
// CTR per medium — is unreadable on this network today: every slot and every
// campaign belong to the same account, so clicks book as free self-deal and the
// last valid click was 2026-07-29. A table of five 0.000% rows invites exactly
// the wrong conclusion ("motion does nothing"), so this module reports the
// delivery mix as fact and is explicit about the rate being unavailable rather
// than zero.
//
// The rates themselves are derived here rather than in SQL so every surface —
// the dashboard, the CLI, the API — divides the same way.

import type { SupabaseClient } from "@supabase/supabase-js";
import { rangeSince, type RangeDef } from "./ranges";
import { rpcFailed, type Loaded } from "@/lib/loaded";
import { AD_MEDIA_KINDS, type AdMediaKind } from "./media";

/**
 * The bucket the rollup uses for delivery that belongs to no arm: an impression
 * served before the rotation existed (media NULL), or a click whose impression
 * can no longer be resolved. Reported, never included in a share or a rate —
 * counting the pre-rotation archive as 'static' would make static the permanent
 * winner of an experiment it never ran in.
 */
export const UNATTRIBUTED = "unknown";

export type MediaSplitRow = {
  media: string;
  /** True for the five real arms; false for UNATTRIBUTED. */
  rotated: boolean;
  /** Paid + free. Everything actually shown, which is what a mix describes. */
  impressions: number;
  paidImpressions: number;
  freeImpressions: number;
  clicks: number;
  freeClicks: number;
  spentCents: number;
  /** Share of rotated delivery, 0-1. Zero for UNATTRIBUTED. */
  share: number;
  /** clicks / impressions, or null when there is nothing to divide. */
  ctr: number | null;
};

type Row = {
  media: string | null;
  impressions: number | string;
  free_impressions: number | string;
  clicks: number | string;
  free_clicks: number | string;
  spent_cents: number | string;
};

const n = (v: number | string | null | undefined): number => Number(v) || 0;

function isRotated(media: string): media is AdMediaKind {
  return (AD_MEDIA_KINDS as readonly string[]).includes(media);
}

/**
 * Shape the RPC's rows into the table the UI draws.
 *
 * Pure, so the share and rate arithmetic is testable without a database — which
 * matters because both have an edge case that reads as a real number if it is
 * got wrong: a share denominated on total delivery (including UNATTRIBUTED)
 * would make every arm look tiny while the archive dominates, and a CTR of 0
 * where there were no clicks to count is indistinguishable from a medium nobody
 * clicked.
 */
export function mediaSplitRows(rows: Row[]): MediaSplitRow[] {
  const mapped = rows.map((r) => {
    const media = r.media ?? UNATTRIBUTED;
    const paidImpressions = n(r.impressions);
    const freeImpressions = n(r.free_impressions);
    const clicks = n(r.clicks);
    const freeClicks = n(r.free_clicks);
    const impressions = paidImpressions + freeImpressions;
    return {
      media,
      rotated: isRotated(media),
      impressions,
      paidImpressions,
      freeImpressions,
      clicks,
      freeClicks,
      spentCents: n(r.spent_cents),
      share: 0,
      // Null, not 0: "nobody clicked this" and "nothing was measured" are
      // different findings and only one of them is about the medium.
      ctr: impressions > 0 ? (clicks + freeClicks) / impressions : null,
    };
  });

  // Denominated on rotated delivery only, so the shares of the five arms sum to
  // 1 regardless of how much pre-rotation archive the window happens to include.
  const rotatedTotal = mapped
    .filter((r) => r.rotated)
    .reduce((a, r) => a + r.impressions, 0);

  for (const row of mapped) {
    row.share = row.rotated && rotatedTotal > 0 ? row.impressions / rotatedTotal : 0;
  }

  // Biggest arm first, and the unattributed bucket always last — it is context,
  // not a competitor.
  return mapped.sort((a, b) => {
    if (a.rotated !== b.rotated) return a.rotated ? -1 : 1;
    return b.impressions - a.impressions;
  });
}

/** Rotated delivery in the window — the denominator, and whether there is one. */
export function rotatedImpressions(rows: MediaSplitRow[]): number {
  return rows.filter((r) => r.rotated).reduce((a, r) => a + r.impressions, 0);
}

/** Every click attributed to a medium in the window, paid or free. */
export function attributedClicks(rows: MediaSplitRow[]): number {
  return rows.filter((r) => r.rotated).reduce((a, r) => a + r.clicks + r.freeClicks, 0);
}

/**
 * Whether the CTR column means anything yet.
 *
 * Deliberately a hard gate rather than a caveat in small print. With no clicks
 * at all, every arm reads 0.000% and the table looks like a finished experiment
 * that found nothing — which is the single most likely way this feature gets
 * misread. Below the threshold the UI shows the mix and hides the rate.
 *
 * 30 is not a power calculation; it is the point below which a rate would be
 * noise whatever it said. A real decision between five arms needs far more, and
 * the note says so.
 */
export const MIN_CLICKS_TO_COMPARE = 30;

export function ctrReadable(rows: MediaSplitRow[]): boolean {
  return attributedClicks(rows) >= MIN_CLICKS_TO_COMPARE;
}

/**
 * One line on why the rate column is missing, or undefined when it is shown.
 *
 * Names the actual reason rather than "not enough data": on this network the
 * cause is structural (no third-party demand, so no billable clicks) and will
 * not fix itself by waiting, which is a different instruction to the reader
 * than "come back tomorrow".
 */
export function ctrUnreadableNote(rows: MediaSplitRow[]): string | undefined {
  if (ctrReadable(rows)) return undefined;
  const clicks = attributedClicks(rows);
  const delivery = rotatedImpressions(rows);
  if (delivery === 0) {
    return "No rotated delivery in this range yet — the mix appears once slots start serving.";
  }
  if (clicks === 0) {
    return `${delivery.toLocaleString()} impressions across the media above and no clicks yet, so there is no rate to compare. Click-through cannot separate these arms until a third-party advertiser exists: every campaign and slot on the network share one account, so clicks book as free self-deal. Playback (start and completion on the video and audio arms) is the signal that does work today.`;
  }
  return `Only ${clicks.toLocaleString()} click${clicks === 1 ? "" : "s"} attributed so far — under ${MIN_CLICKS_TO_COMPARE}, a per-medium rate is noise. Showing the delivery mix only.`;
}

/**
 * Delivery per medium over a range, for the signed-in advertiser's campaigns.
 *
 * Reads the rollup-backed RPC rather than raw events: ad_impressions is ~376k
 * rows growing ~90k/day and a `group by media` over a 30-day window is the
 * scan that 20260902140000 exists to avoid.
 */
export async function getMediaSplit(
  supabase: SupabaseClient,
  range: RangeDef,
  now: Date = new Date(),
): Promise<Loaded<MediaSplitRow[]>> {
  const { data, error } = await supabase.rpc("ad_owner_media_split", {
    p_since: rangeSince(range, now),
  });

  const failed = rpcFailed("ads", "ad_owner_media_split", error);
  return { data: failed ? [] : mediaSplitRows((data as Row[]) ?? []), failed };
}
