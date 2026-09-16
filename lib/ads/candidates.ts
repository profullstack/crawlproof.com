import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdFormatId } from "./creative";

// A page size, never a cap on the auction. The old LIMIT 100 excluded newer
// campaigns entirely once a format had more than 100 ready creatives.
const PAGE_SIZE = 500;
const COLUMNS = "id, campaign_id, format, headline, body, cta_text, image_url, logo_url, bg_color, fg_color, accent_color, light_bg_color, light_fg_color, light_accent_color, font_family, ad_campaigns!inner(id, owner_id, status, ref_slug, destination_url, daily_budget_cents, spend_today_cents, spend_date, bid_credits)";

export async function loadServingCreatives(sb: SupabaseClient, format: AdFormatId) {
  const rows = [];
  let after: string | undefined;
  for (;;) {
    let query = sb.from("ad_creatives")
      .select(COLUMNS)
      .eq("format", format)
      .eq("status", "ready")
      .in("ad_campaigns.status", ["active", "exhausted"])
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (after) query = query.gt("id", after);
    const { data, error } = await query;
    if (error) {
      // Never run an auction against a silently incomplete candidate pool.
      console.error("[ads] creative inventory unavailable", error.message);
      return [];
    }
    if (!data?.length) return rows;
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
    after = data[data.length - 1].id as string;
  }
}
