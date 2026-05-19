import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSite } from "@/lib/lx/currentSite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Used by the autoblog dashboard to poll for an article that landed
// after a user clicked "Generate article now". Returns the newest
// lx_article for the current site whose created_at is > ?since, or
// 204 if nothing yet. Owner-scoped via getCurrentSite.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const site = (await getCurrentSite("id")) as
    | { id: string; lx_site_id: string | null }
    | null;
  if (!site?.lx_site_id) {
    return NextResponse.json({ ok: false, error: "no site" }, { status: 404 });
  }

  const sinceParam = req.nextUrl.searchParams.get("since");
  const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 5 * 60_000);
  if (Number.isNaN(since.getTime())) {
    return NextResponse.json({ ok: false, error: "bad since" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("lx_article")
    .select("id, status, title, created_at")
    .eq("site_id", site.lx_site_id)
    .gt("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!data) {
    return new NextResponse(null, { status: 204 });
  }
  return NextResponse.json({ ok: true, article: data });
}
