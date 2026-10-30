"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { globalWalletProfile } from "@/lib/coinpay-wallets";
export async function selectGlobalCoinpayWallet(walletId: string) {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  const sb = serviceClient();
  const profile = await globalWalletProfile(sb, user.id);
  if (!profile.connected || !profile.wallets.some((w) => w.id === walletId)) return { ok: false, error: "Choose a wallet from your connected CoinPay account." };
  const { error } = await sb.from("coinpay_wallet_profiles").update({ preferred_wallet_id: walletId }).eq("user_id", user.id);
  if (error) return { ok: false, error: "Could not save your global wallet." };
  revalidatePath("/dashboard/ads/slots");return { ok: true };
}
