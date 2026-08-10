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
