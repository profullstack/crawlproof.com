import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProjectById, getCurrentSite } from "@/lib/lx/currentSite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Used by the autoblog dashboard to poll for an article that landed
// after a user clicked "Generate article now". Returns the newest
// lx_article whose created_at is > ?since, or 204 if nothing yet.
//
// Site resolution: prefer ?projectId from the caller (the dashboard
// route knows its project ID from the URL). Fall back to the
// current_site_id cookie when no projectId is given. Without the
// explicit param, users with multiple projects would poll the wrong
// site whenever the cookie drifted.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const projectIdParam = req.nextUrl.searchParams.get("projectId");
  let lxSiteId: string | null = null;
  if (projectIdParam) {
    const project = await getProjectById(projectIdParam, { siteColumns: "id" });
    const lxSite = project?.lx_site as { id?: string } | null;
    lxSiteId = lxSite?.id ?? null;
  } else {
    const site = (await getCurrentSite("id")) as
      | { id: string; lx_site_id: string | null }
      | null;
    lxSiteId = site?.lx_site_id ?? null;
  }
  if (!lxSiteId) {
    return NextResponse.json({ ok: false, error: "no site" }, { status: 404 });
  }

  const sinceParam = req.nextUrl.searchParams.get("since");
  const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 5 * 60_000);
  if (Number.isNaN(since.getTime())) {
    return NextResponse.json({ ok: false, error: "bad since" }, { status: 400 });
  }

  // Default to status='ready' (i.e. an article the user can actually
  // preview/publish). The dashboard polls for this after a manual
  // Generate; without the filter we'd return an in-flight 'generating'
  // row and the redirect would land on an empty article page. Callers
  // that want any new row can pass ?status=any.
  const statusFilter = req.nextUrl.searchParams.get("status") ?? "ready";

  let query = supabase
    .from("lx_article")
    .select("id, status, title, created_at")
    .eq("site_id", lxSiteId)
    .gt("created_at", since.toISOString());
  if (statusFilter !== "any") {
    query = query.eq("status", statusFilter);
  }

  const { data, error } = await query
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
