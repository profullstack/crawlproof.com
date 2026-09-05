// /api/ads/v1/campaigns/[id] — one campaign, by id or ref slug (crawlproof-ad-144).
//
//   GET     the campaign and its delivery: impressions, clicks, spend, and the
//           visits the tracker attributed to it (bucket ad:<ref>) on the
//           caller's own sites.
//   PATCH   { name?, daily_budget_cents?, bid_credits?, status? }
//           status is active | paused | draft. Going active needs a creative.
//   DELETE  removes it, metering included. Pause keeps the history.
//
// Same auth as the collection route. This is what `crawlproof ads show|pause|
// resume|budget|delete` and the myna plugin call.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { campaignStats, deleteCampaign, findCampaign, parseCampaignPatch, patchCampaign } from "@/lib/ads/campaigns";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const siteUrl = () => (env.siteUrl || "https://crawlproof.com").replace(/\/$/, "");
type Ctx = { params: Promise<{ id: string }> };

async function load(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return { error: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  const { id } = await ctx.params;
  const sb = serviceClient();
  const campaign = await findCampaign(sb, auth.userId, id);
  if (!campaign) return { error: NextResponse.json({ error: "No such campaign." }, { status: 404 }) };
  return { sb, userId: auth.userId, campaign };
}

const withUrl = <T extends { id: string }>(c: T) => ({ ...c, dashboard_url: `${siteUrl()}/dashboard/ads/${c.id}` });

export async function GET(req: NextRequest, ctx: Ctx) {
  const loaded = await load(req, ctx);
  if ("error" in loaded) return loaded.error;
  const stats = await campaignStats(loaded.sb, loaded.userId, loaded.campaign);
  return NextResponse.json({ ...withUrl(loaded.campaign), stats });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const loaded = await load(req, ctx);
  if ("error" in loaded) return loaded.error;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = parseCampaignPatch(body ?? {});
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const result = await patchCampaign(loaded.sb, loaded.userId, loaded.campaign, parsed.patch);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(withUrl(result.campaign));
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const loaded = await load(req, ctx);
  if ("error" in loaded) return loaded.error;
  const result = await deleteCampaign(loaded.sb, loaded.userId, loaded.campaign);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, deleted: loaded.campaign.ref_slug });
}
