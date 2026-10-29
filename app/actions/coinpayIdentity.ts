"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { disconnectCoinpay, supabaseCoinpayStore } from "@/lib/coinpay-signin";

// Settings → CoinPay → Disconnect. Refused when CoinPay is the only way in.
export async function disconnectCoinpayAction(): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { ok: false, error: "Sign in first." };
  const r = await disconnectCoinpay(data.user.id, data.user.email ?? null, supabaseCoinpayStore(serviceClient()));
  if (r.ok) revalidatePath("/dashboard/settings");
  return r;
}
