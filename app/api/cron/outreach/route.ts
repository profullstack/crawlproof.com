import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import {
  CAMPAIGN_COLUMNS,
  runEmailCampaignTick,
  summarize,
  type CampaignRow,
} from "@/lib/outreach/runner";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * The lead-generation autopilot. One tick advances every active campaign:
 * follow-ups first, then first contacts, then research on scans that landed,
 * then new discovery to refill the funnel.
 *
 * Schedule it every 15 minutes. Ticking faster does not help — the slow step
 * is the scan worker, and the daily send caps are the real throttle.
 *
 * Campaigns with auto_send off (the default) run the whole funnel and stop at
 * the wire, logging each message as a dry run. That is the intended way to
 * start one: let it build a pipeline, read what it wrote, then turn sending
 * on deliberately.
 */
export async function GET(req: Request) {
  return POST(req);
}

export async function POST(req: Request) {
  const incoming =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (incoming !== env.cronSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { data, error } = await serviceClient()
    .from("outreach_campaigns")
    .select(CAMPAIGN_COLUMNS)
    .eq("active", true)
    .eq("channel", "email")
    // Oldest tick first, so one busy campaign cannot starve the others when
    // the run hits maxDuration.
    .order("last_run_at", { ascending: true, nullsFirst: true })
    .limit(10);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  const campaigns = (data as CampaignRow[] | null) ?? [];
  if (!campaigns.length) {
    return NextResponse.json({ ok: true, campaigns: 0, note: "no active campaigns" });
  }

  const results = [];
  for (const campaign of campaigns) {
    try {
      const tick = await runEmailCampaignTick(campaign);
      results.push({ ...tick, summary: summarize(tick) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      results.push({ campaign: campaign.name, summary: `failed: ${message}`, errors: [message] });
      await serviceClient()
        .from("outreach_campaigns")
        .update({ last_run_at: new Date().toISOString(), last_run_note: `failed: ${message}` })
        .eq("id", campaign.id);
    }
  }

  return NextResponse.json({
    ok: true,
    campaigns: campaigns.length,
    sent: results.reduce((n, r) => n + (("sent" in r ? r.sent : 0) ?? 0), 0),
    results,
  });
}
