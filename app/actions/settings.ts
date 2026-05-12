"use server";

import { createClient } from "@/lib/supabase/server";

export async function saveSettings(input: {
  displayName: string;
  retainRawHtml: boolean;
}): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  const { error } = await supabase
    .from("profiles")
    .update({ display_name: input.displayName, retain_raw_html: input.retainRawHtml })
    .eq("id", user.id);
  return { ok: !error };
}
