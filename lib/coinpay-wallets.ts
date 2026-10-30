import type { SupabaseClient } from "@supabase/supabase-js";
import type { GlobalCoinpayWallet } from "./coinpay-wallet-data";
export type WalletProfile = { configured: boolean; connected: boolean; wallets: GlobalCoinpayWallet[]; selected: GlobalCoinpayWallet | null; syncedAt: string | null };
export async function globalWalletProfile(sb: SupabaseClient, userId: string): Promise<WalletProfile> {
  const [{ data: p, error }, { data: identity, error: identityError }] = await Promise.all([
    sb.from("coinpay_wallet_profiles").select("coinpay_sub, wallets, preferred_wallet_id, synced_at").eq("user_id", userId).maybeSingle(),
    sb.from("coinpay_identities").select("coinpay_sub").eq("user_id", userId).maybeSingle(),
  ]);
  if (error || identityError) throw new Error("Could not load your CoinPay wallet connection.");
  const connected = !!p && !!identity && p.coinpay_sub === identity.coinpay_sub;
  const wallets: GlobalCoinpayWallet[] = connected && Array.isArray(p.wallets) ? p.wallets : [];
  return { configured: !!p, connected, wallets, selected: wallets.find((w) => w.id === p?.preferred_wallet_id) ?? wallets[0] ?? null, syncedAt: connected ? p.synced_at : null };
}
export async function saveGlobalWalletProfile(sb: SupabaseClient, userId: string, sub: string, wallets: GlobalCoinpayWallet[]) {
  const { data: identity, error: identityError } = await sb.from("coinpay_identities").select("coinpay_sub").eq("user_id", userId).maybeSingle();
  if (identityError || identity?.coinpay_sub !== sub) throw new Error("CoinPay account does not match this connection.");
  // Preserve a chosen global destination if it is still in the fresh provider list.
  const { data: previous, error: readError } = await sb.from("coinpay_wallet_profiles").select("preferred_wallet_id").eq("user_id", userId).maybeSingle();
  if (readError) throw new Error("Could not load your wallet preference.");
  const preferred = wallets.find((w) => w.id === previous?.preferred_wallet_id)?.id ?? wallets[0]?.id ?? null;
  const { error } = await sb.from("coinpay_wallet_profiles").upsert({ user_id: userId, coinpay_sub: sub, wallets, preferred_wallet_id: preferred, synced_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw new Error("Could not save your CoinPay wallets.");
}
export async function slotPayoutTarget(sb: SupabaseClient, userId: string, slot: { payout_address?: string | null; payout_currency?: string | null }) {
  const profile = await globalWalletProfile(sb, userId);
  if (profile.configured) {
    if (!profile.connected) return { ok: false as const, error: "Reconnect CoinPay wallets before withdrawing." };
    if (!profile.selected) return { ok: false as const, error: "No active global CoinPay wallet is available. Add one in CoinPay and refresh the connection." };
    return { ok: true as const, address: profile.selected.address, currency: profile.selected.currency, source: "coinpay" as const };
  }
  // Existing customers keep legacy destinations until they explicitly connect globals.
  if (slot.payout_address) return { ok: true as const, address: slot.payout_address, currency: slot.payout_currency || "usdc_pol", source: "legacy" as const };
  return { ok: false as const, error: "Connect CoinPay wallets once to use them across all your sites." };
}
