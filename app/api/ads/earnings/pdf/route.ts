// PDF earnings/spend report for the logged-in account. Runs the same
// RLS-scoped queries as /ads/earnings, renders a self-contained HTML report,
// and hands it to the worker's Playwright /pdf endpoint (html branch).

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { loadEarnings } from "@/lib/ads/earnings-data";
import { buildEarningsReportHtml } from "@/lib/ads/earnings-report";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  if (!env.workerUrl) {
    return NextResponse.json({ error: "Worker not configured" }, { status: 500 });
  }

  const daysParam = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(daysParam) && daysParam >= 1 && daysParam <= 365 ? Math.floor(daysParam) : 30;

  const model = await loadEarnings(supabase, user.id, days);
  const html = buildEarningsReportHtml({
    model,
    account: user.email ?? user.id,
    generatedAt: new Date().toISOString(),
  });

  const workerRes = await fetch(`${env.workerUrl}/pdf`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": env.workerSecret },
    body: JSON.stringify({ html }),
  });
  if (!workerRes.ok) {
    return NextResponse.json({ error: "PDF render failed" }, { status: 502 });
  }
  const buf = await workerRes.arrayBuffer();
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(buf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="crawlproof-earnings-${stamp}.pdf"`,
    },
  });
}
