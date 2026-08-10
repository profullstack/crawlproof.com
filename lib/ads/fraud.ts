import { serviceClient } from "@/lib/supabase/service";

// Click-validity checks that gate whether a click bills the advertiser and
// accrues to the publisher. Cheap, best-effort, and conservative: when in
// doubt we still redirect the user, we just don't charge for the click.

// A visitor is counted at most once per campaign within this window. Exported
// so callers can ask lib/ipHash for every rotating hash an IP could have been
// stored under across the same span.
export const CLICK_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h

export function isBotDevice(device?: string | null): boolean {
  return device === "bot";
}

// PostgREST .or() interpolates raw — only allow safe identifier chars so a
// forged visitorId can't inject filter syntax.
function safeId(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  return /^[\w-]{1,128}$/.test(s) ? s : null;
}

// Impressions get a much shorter window than clicks, and are keyed on the slot
// rather than the campaign.
//
// Both choices come from what the inflation actually looks like. A scheduled
// pool refresher fetches one slot N times back to back to fill N cache entries;
// each fetch picks a *different* campaign at random, so campaign-keyed dedupe
// (the shape used for clicks) collapses none of it. Slot-keyed dedupe collapses
// the whole burst to one counted impression.
//
// 5s rather than the click path's 6h, because a repeat view is a real thing: a
// human reloading an article genuinely saw the ad twice, and a long window
// erases legitimate delivery.
//
// This shipped at 60s, chosen by reasoning about human behaviour. Backtesting
// the rule against 7 days of real impressions showed that was wrong — the
// machine bursts are compressed into seconds, so a wide window costs a great
// deal of real delivery to catch almost nothing extra:
//
//   window   terminal flagged (target)   web flagged (cost)
//    3s              84.5%                     12.2%
//    5s              84.6%                     14.2%
//   10s              84.7%                     17.5%
//   60s              85.4%                     36.6%
//
// 60s bought +0.9pp on the target and cost 22pp of real web impressions. 5s
// keeps essentially all of the burst suppression — the observed burst spans
// ~2.5s — with a little margin for a slower run, since each fetch in the loop
// can take up to its own timeout.
//
// The ~12-14% web floor that remains at short windows is not noise: it is the
// same visitor re-fetching the same slot sub-second, which is /ad.js clearing
// data-cp-filled in its .catch() path and SPA callers re-firing scan(). That is
// a real double-count bug and dedupe only masks it.
export const IMPRESSION_DEDUPE_WINDOW_MS = 5 * 1000;

export type ClickValidity = { valid: boolean; reason?: string };

export async function assessClickValidity(input: {
  campaignId: string;
  slotId?: string | null;
  impressionId?: string | null;
  visitorId?: string | null;
  /**
   * Every rotating IP hash to match against — today's plus any earlier salt
   * window still inside CLICK_DEDUPE_WINDOW_MS. A single hash would stop
   * matching yesterday's rows the moment the salt rotates.
   */
  ipHashes?: string[] | null;
  device?: string | null;
}): Promise<ClickValidity> {
  // 1. Bots never bill.
  if (isBotDevice(input.device)) return { valid: false, reason: "bot" };

  const sb = serviceClient();

  // 2. Anti-forgery: if the click claims an impression, it must exist and match
  // the campaign/slot it says it clicked.
  if (input.impressionId) {
    const { data: imp } = await sb
      .from("ad_impressions")
      .select("campaign_id, slot_id")
      .eq("id", input.impressionId)
      .maybeSingle();
    if (!imp) return { valid: false, reason: "no_impression" };
    if (imp.campaign_id !== input.campaignId) return { valid: false, reason: "impression_mismatch" };
    if (input.slotId && imp.slot_id !== input.slotId) return { valid: false, reason: "impression_mismatch" };
  }

  // 3. Dedupe on this campaign by visitor id or ip hash within the window.
  const visitor = safeId(input.visitorId);
  const ipHashes = (input.ipHashes ?? [])
    .map((h) => safeId(h))
    .filter((h): h is string => h !== null);
  if (!visitor && ipHashes.length === 0) return { valid: true }; // nothing to dedupe on

  const since = new Date(Date.now() - CLICK_DEDUPE_WINDOW_MS).toISOString();
  const q = sb
    .from("ad_clicks")
    .select("id")
    .eq("campaign_id", input.campaignId)
    .eq("valid", true)
    .gte("ts", since)
    .limit(1);

  // One .or() covering every identifier: the visitor id plus each salt window's
  // hash. Every term has been through safeId, so nothing unescaped reaches
  // PostgREST's filter syntax.
  const terms = [
    ...(visitor ? [`visitor_id.eq.${visitor}`] : []),
    ...ipHashes.map((h) => `ip_hash.eq.${h}`),
  ];

  const { data: dupe } = await q.or(terms.join(","));
  if (dupe && dupe.length > 0) return { valid: false, reason: "duplicate" };

  return { valid: true };
}

/**
 * Has this viewer already been counted on this slot inside the dedupe window?
 *
 * Deliberately does NOT stop the ad being served or the row being written — the
 * caller still inserts an impression, just flagged. Two reasons the row has to
 * exist either way:
 *
 *   1. Click attribution. A terminal click URL is /a/<short_code>, which
 *      resolves the campaign and creative back off the impression row. Skipping
 *      the insert would serve a real advertiser's creative with a click link
 *      that resolves to nothing — the click would go unbilled and the publisher
 *      unpaid, which is strictly worse than an inflated count.
 *   2. Each fetch in a burst renders a *different* campaign, so there is no one
 *      earlier row that could stand in for the rest without misattributing
 *      every later click to the first campaign.
 *
 * Best-effort: a failed lookup returns false (count it) rather than throwing.
 * Losing an impression is worse than counting one twice.
 */
export async function isDuplicateImpression(input: {
  slotId: string;
  visitorId?: string | null;
  ipHashes?: string[] | null;
}): Promise<boolean> {
  const visitor = safeId(input.visitorId);
  const ipHashes = (input.ipHashes ?? [])
    .map((h) => safeId(h))
    .filter((h): h is string => h !== null);
  if (!visitor && ipHashes.length === 0) return false; // nothing to dedupe on

  const terms = [
    ...(visitor ? [`visitor_id.eq.${visitor}`] : []),
    ...ipHashes.map((h) => `ip_hash.eq.${h}`),
  ];

  const since = new Date(Date.now() - IMPRESSION_DEDUPE_WINDOW_MS).toISOString();
  try {
    const { data, error } = await serviceClient()
      .from("ad_impressions")
      .select("id")
      .eq("slot_id", input.slotId)
      .gte("ts", since)
      .limit(1)
      .or(terms.join(","));

    if (error) return false;
    return !!data && data.length > 0;
  } catch {
    // Never let the dedupe probe take serving down with it. This runs on the
    // hot path of every fill; if it throws, the right answer is "count it" and
    // carry on, not to lose the impression and the click that may follow.
    return false;
  }
}
