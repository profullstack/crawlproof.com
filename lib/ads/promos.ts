// The 90-day trending promo, as rows.
//
// An advertiser who turns trending targeting on gets ninety days during which
// their campaign serves and meters exactly as it always would and every click
// is charged nothing. The entitlement is a row rather than a flag with a date
// on the campaign, because "was this click free?" has to stay answerable after
// the promo ends, after the campaign is edited, and after the price changes.
//
// Granting is idempotent and never extends: a second opt-in reads the first
// promo back. Ninety days free is ninety days, not ninety per toggle.

import type { SupabaseClient } from "@supabase/supabase-js";
import { TRENDING_CPC_CENTS } from "./pricing";
import { PROMO_KIND, promoState, promoWindow, type Promo, type PromoState } from "./trending";

type PromoRow = {
  id: string;
  owner_id: string;
  campaign_id: string | null;
  kind: string;
  cpc_cents: number | null;
  starts_at: string;
  ends_at: string;
  revoked_at: string | null;
};

const COLUMNS = "id, owner_id, campaign_id, kind, cpc_cents, starts_at, ends_at, revoked_at";

const rowToPromo = (row: PromoRow): Promo => ({
  id: row.id,
  ownerId: row.owner_id,
  campaignId: row.campaign_id,
  kind: row.kind,
  cpcCents: Number(row.cpc_cents) || 0,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  revokedAt: row.revoked_at,
});

/**
 * The live promo for a campaign, or null.
 *
 * Every failure reads as "no promo": the table rides behind a migration
 * applied by hand, and a missing table must mean an advertiser is billed
 * normally, never that everybody's clicks become free.
 */
export async function promoForCampaign(
  sb: SupabaseClient,
  campaignId: string,
): Promise<Promo | null> {
  if (!campaignId || campaignId === "house") return null;
  try {
    const { data, error } = await sb
      .from("ad_promos")
      .select(COLUMNS)
      .eq("campaign_id", campaignId)
      .eq("kind", PROMO_KIND)
      .is("revoked_at", null)
      .order("ends_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return rowToPromo(data as PromoRow);
  } catch {
    return null;
  }
}

/** Live promos for several campaigns at once, keyed by campaign id. Serving path. */
export async function promosForCampaigns(
  sb: SupabaseClient,
  campaignIds: string[],
): Promise<Map<string, Promo>> {
  const out = new Map<string, Promo>();
  const ids = [...new Set(campaignIds.filter(Boolean))];
  if (!ids.length) return out;
  try {
    const { data, error } = await sb
      .from("ad_promos")
      .select(COLUMNS)
      .in("campaign_id", ids)
      .eq("kind", PROMO_KIND)
      .is("revoked_at", null);
    if (error || !data) return out;
    for (const row of data as PromoRow[]) {
      if (row.campaign_id) out.set(row.campaign_id, rowToPromo(row));
    }
  } catch {
    return out;
  }
  return out;
}

/** Where a campaign's promo stands, ready for a dashboard or a CLI line. */
export async function promoStateForCampaign(
  sb: SupabaseClient,
  campaignId: string,
  now = Date.now(),
): Promise<PromoState> {
  return promoState(await promoForCampaign(sb, campaignId), now);
}

export type GrantResult = {
  promo: Promo | null;
  state: PromoState;
  /** True when this call is what created the promo. */
  granted: boolean;
};

/**
 * Give a campaign its ninety days, once.
 *
 * Called when trending targeting is turned on. An existing promo — live or
 * expired — is returned untouched: re-granting on every toggle would make the
 * promo infinite, and quietly restarting an expired one would give a campaign
 * a second ninety days nobody agreed to.
 *
 * A failure to write is not a failure to save the campaign. The advertiser
 * asked for trending targeting; the promo is what we owe them for it, and if
 * the row cannot be written the campaign still targets and simply bills
 * normally. That is visible — the dashboard shows no promo — rather than
 * silent.
 */
export async function grantTrendingPromo(
  sb: SupabaseClient,
  input: { userId: string; campaignId: string; now?: number; note?: string },
): Promise<GrantResult> {
  const now = input.now ?? Date.now();
  const existing = await promoForCampaign(sb, input.campaignId);
  if (existing) return { promo: existing, state: promoState(existing, now), granted: false };

  const { startsAt, endsAt } = promoWindow(now);
  try {
    const { data, error } = await sb
      .from("ad_promos")
      .insert({
        owner_id: input.userId,
        campaign_id: input.campaignId,
        kind: PROMO_KIND,
        cpc_cents: TRENDING_CPC_CENTS,
        starts_at: startsAt,
        ends_at: endsAt,
        note: (input.note ?? "").slice(0, 200),
      })
      .select(COLUMNS)
      .single();
    if (error || !data) {
      // Another request may have granted it a moment ago; the unique index is
      // the arbiter, so read rather than assume.
      const again = await promoForCampaign(sb, input.campaignId);
      return { promo: again, state: promoState(again, now), granted: false };
    }
    const promo = rowToPromo(data as PromoRow);
    return { promo, state: promoState(promo, now), granted: true };
  } catch {
    return { promo: null, state: promoState(null, now), granted: false };
  }
}
