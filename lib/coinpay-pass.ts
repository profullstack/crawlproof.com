// Profullstack Pass (2026-11-07): a user who deposits $99 into their own
// CoinPay wallet gets a free month on every Profullstack property. crawlproof is
// pay-as-you-go, so the pass pays the smallest credit pack once per pass, through
// grant_code_credits() (promo credits: never cash-backed, never paid out to a
// publisher). Keyed on 'coinpay-pass:<sub>:<expires_at>': a repeat sign-in
// during the same pass never pays twice, a renewal pays again, and a second
// crawlproof account linked to the same CoinPay sub gets nothing.
//
// CoinPay reports the pass on userinfo, which is only seen at sign-in, so the
// callback stores coinpay_identities.pass_until and calls applyCoinpayPass().
import type { CoinpayPass } from "@profullstack/coinpay-onboard/pass";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CREDIT_PACKS } from "./credits";

export { PASS_URL, passFromUserinfo } from "@profullstack/coinpay-onboard/pass";

/** What one pass is worth here: the smallest (cheapest) credit pack. */
export const PASS_CREDITS = [...CREDIT_PACKS].sort((a, b) => a.amountCents - b.amountCents)[0]!.credits;

export const passSource = (sub: string, expiresAt: Date) => `coinpay-pass:${sub}:${expiresAt.toISOString()}`;

export interface PassStore {
  setPassUntil(userId: string, sub: string, until: string | null): Promise<void>;
  /** applied=false when this source was already paid (to anyone). */
  grantOnce(userId: string, credits: number, source: string): Promise<{ applied: boolean }>;
}

export async function applyCoinpayPass(
  store: PassStore,
  userId: string,
  sub: string,
  pass: CoinpayPass,
  now: Date = new Date(),
): Promise<boolean> {
  const active = pass.active && pass.expiresAt !== null && pass.expiresAt.getTime() > now.getTime();
  await store.setPassUntil(userId, sub, active ? pass.expiresAt!.toISOString() : null);
  if (!active) return false;
  return (await store.grantOnce(userId, PASS_CREDITS, passSource(sub, pass.expiresAt!))).applied;
}

export function supabasePassStore(sb: SupabaseClient): PassStore {
  return {
    async setPassUntil(userId, sub, until) {
      const { error } = await sb
        .from("coinpay_identities")
        .update({ pass_until: until })
        .eq("user_id", userId)
        .eq("coinpay_sub", sub);
      if (error) throw new Error(`pass_until: ${error.message}`);
    },
    async grantOnce(userId, credits, source) {
      const { data, error } = await sb.rpc("grant_code_credits", { p_user: userId, p_source: source, p_credits: credits });
      if (error) {
        // code_credit_grants_one_coinpay_pass_idx: another account linked to the same sub was paid.
        if (error.code === "23505" || /duplicate key/i.test(error.message)) return { applied: false };
        throw new Error(`grant_code_credits: ${error.message}`);
      }
      return { applied: Boolean((data as { applied?: boolean } | null)?.applied) };
    },
  };
}
