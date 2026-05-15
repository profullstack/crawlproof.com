"use server";

import { createClient } from "@/lib/supabase/server";
import { isValidTimezone } from "@/lib/timezones";

const ALLOWED_CADENCES = ["off", "weekly", "monthly"] as const;
type Cadence = (typeof ALLOWED_CADENCES)[number];

export async function saveSettings(input: {
  displayName: string;
  retainRawHtml: boolean;
  perfReportCadence: Cadence;
  timezone: string;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };

  if (!ALLOWED_CADENCES.includes(input.perfReportCadence)) {
    return { ok: false, error: "invalid cadence" };
  }
  if (!isValidTimezone(input.timezone)) {
    return { ok: false, error: "invalid timezone" };
  }

  const { error } = await supabase
    .from("profiles")
    .update({
      display_name: input.displayName,
      retain_raw_html: input.retainRawHtml,
      perf_report_cadence: input.perfReportCadence,
      timezone: input.timezone,
    })
    .eq("id", user.id);
  return error ? { ok: false, error: error.message } : { ok: true };
}
