// /api/ads/v1/campaigns — campaigns for a bearer-token caller.
//
//   POST { url, name?, daily_budget_cents?, bid_credits?, status?,
//          trending_topics?, topics? }
//        Read the page, write the creatives, save the campaign. Active unless
//        status is "draft". A live campaign for the same URL is returned
//        instead of a twin, with `existing: true`.
//        `trending_topics: true` opts into trending-topic targeting and grants
//        the 90-day premium promo — see lib/ads/promos.ts. Topics default to
//        what the landing page is about.
//   GET  ?limit=20
//        The caller's campaigns, newest first.
//
// Same auth as /api/sp/v1/* and the MCP server: `Authorization: Bearer crp_…`
// from Social → API tokens. This is what `crawlproof ads` and the myna
// crawlproof plugin call.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { createCampaignForUrl, listCampaigns, parseCampaignRequest } from "@/lib/ads/campaigns";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Reading the page and writing four creatives takes a while.
export const maxDuration = 120;

const siteUrl = () => (env.siteUrl || "https://crawlproof.com").replace(/\/$/, "");

export async function POST(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = parseCampaignRequest(body ?? {});
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const sb = serviceClient();
  const { data: profile } = await sb.from("profiles").select("email").eq("id", auth.userId).maybeSingle();
  const result = await createCampaignForUrl({
    sb,
    userId: auth.userId,
    email: (profile as { email?: string | null } | null)?.email ?? null,
    request: parsed.request,
    siteUrl: siteUrl(),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.campaign, { status: result.campaign.existing ? 200 : 201 });
}

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const limit = Number(new URL(req.url).searchParams.get("limit")) || 20;
  const campaigns = await listCampaigns({ sb: serviceClient(), userId: auth.userId, limit, siteUrl: siteUrl() });
  return NextResponse.json({ campaigns });
}
