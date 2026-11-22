// /api/abtest/v1/experiments/[key]
//
//   GET    the experiment, per-arm stats (exposed, converted, rate + 95% Wilson CI, lift,
//          two-proportion z test p value and P(beats control) against the control,
//          revenue, named events) and a verdict.
//   PATCH  { status?: running|paused|stopped, winner?, name?, description? }
//          stopped is terminal: assign then answers the winner (or control) to everyone.
import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { AbError, experimentStats, experimentView, getExperiment, updateExperiment } from "@/lib/abtest/store";
import { authed, dashboardUrl, errorResponse, jsonBody } from "@/lib/abtest/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const a = await authed(req, true);
  if ("error" in a) return a.error;
  try {
    const { key } = await ctx.params;
    const sb = serviceClient();
    const exp = await getExperiment(sb, a.userId, decodeURIComponent(key));
    if (!exp) throw new AbError(404, "no such experiment");
    const summary = await experimentStats(sb, exp);
    return NextResponse.json({ experiment: { ...experimentView(exp), dashboard_url: dashboardUrl(exp.key) }, summary });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  try {
    const { key } = await ctx.params;
    const exp = await updateExperiment(serviceClient(), a.userId, decodeURIComponent(key), await jsonBody(req));
    return NextResponse.json({ experiment: { ...experimentView(exp), dashboard_url: dashboardUrl(exp.key) } });
  } catch (e) {
    return errorResponse(e);
  }
}
