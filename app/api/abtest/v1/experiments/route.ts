// /api/abtest/v1/experiments
//
//   GET   the caller's experiments
//   POST  { key, name?, description?, arms: ["a","b"] | [{key,label?,weight?}], control?, min_per_arm? }
//         creates the experiment if the key is new; an existing one comes back unchanged
//         (created: false), so a product can call this on every boot.
//
// Auth: `Authorization: Bearer crp_…` (read-only stats tokens may GET).
import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { experimentView, listExperiments, upsertExperiment } from "@/lib/abtest/store";
import { authed, dashboardUrl, errorResponse, jsonBody } from "@/lib/abtest/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const a = await authed(req, true);
  if ("error" in a) return a.error;
  try {
    const rows = await listExperiments(serviceClient(), a.userId);
    return NextResponse.json({ experiments: rows.map((e) => ({ ...experimentView(e), dashboard_url: dashboardUrl(e.key) })) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  try {
    const { experiment, created } = await upsertExperiment(serviceClient(), a.userId, await jsonBody(req));
    return NextResponse.json({ experiment: { ...experimentView(experiment), dashboard_url: dashboardUrl(experiment.key) }, created }, { status: created ? 201 : 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
