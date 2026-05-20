import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { findGuestPostOpportunities } from "@/lib/lx/guestPostMatcher";
import { getProjectById, getCurrentSite } from "@/lib/lx/currentSite";

export const runtime = "nodejs";

// "Find guest post opportunities for me" — given a project, returns a
// ranked list of partner sites the author could write guest posts for,
// with crossed-seed topic suggestions. Read-only; doesn't queue
// anything yet.
export async function POST(req: NextRequest) {
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
      | { lx_site_id: string | null }
      | null;
    lxSiteId = site?.lx_site_id ?? null;
  }
  if (!lxSiteId) {
    return NextResponse.json(
      { ok: false, error: "autoblog not configured for this project" },
      { status: 400 },
    );
  }

  const opportunities = await findGuestPostOpportunities(supabase, lxSiteId);

  // Return the author's existing requests so the UI can flag topics
  // already clicked (queued/generating) or locked (generated).
  const { data: requests } = await supabase
    .from("lx_guest_post_request")
    .select("id, target_site_id, topic, status, article_id")
    .eq("author_site_id", lxSiteId);

  return NextResponse.json({
    ok: true,
    opportunities,
    requests: requests ?? [],
  });
}
