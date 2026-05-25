"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { setCurrentSite } from "@/lib/lx/currentSite";

// Switch the active site cookie. Verifies the signed-in user actually
// owns the target site before flipping — otherwise a stale cookie or
// a hand-crafted request could read another user's data.
export async function switchSite(
  siteId: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data } = await supabase
    .from("lx_site")
    .select("id")
    .eq("id", siteId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data) return { ok: false, error: "Site not found." };

  await setCurrentSite(siteId);
  revalidatePath("/autoblog");
  return { ok: true };
}
