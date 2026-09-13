import { NextRequest, NextResponse } from "next/server";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { readCrawlerActivity } from "@/lib/crawl-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let userId: string | undefined;
  if (request.headers.has("authorization")) {
    const auth = await authenticateBearer(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    userId = auth.userId;
  } else {
    const sb = await createClient();
    userId = (await sb.auth.getUser()).data.user?.id;
  }
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: profile, error } = await serviceClient().from("profiles").select("is_admin").eq("id", userId).maybeSingle();
  if (error || !profile?.is_admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const requested = Number(request.nextUrl.searchParams.get("days") ?? 7);
  const days = Number.isInteger(requested) ? Math.min(31, Math.max(1, requested)) : 7;
  try {
    return NextResponse.json({ scope: "network", rangeDays: days, daily: await readCrawlerActivity(days) }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Crawler activity is temporarily unavailable" }, { status: 503 });
  }
}
