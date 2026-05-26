import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { enqueueKeywordResearch } from "@/lib/lx/workerClient";
import { getProjectById, getCurrentSite } from "@/lib/lx/currentSite";

export const runtime = "nodejs";

// Hard-resets the upcoming queue. Used when the user's seeds, niche,
// modifiers, or long-tail list have changed and the existing queue is
// no longer aligned with what they want to publish.
//
// Deletes queued + failed + stuck generating keywords (failed/generating
// ones were never produced — they're not contractually "history"). Leaves
// published keywords intact so research's dedup still skips topics the site
// has already covered.
// Then enqueues a fresh research run.
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
    const project = await getProjectById(projectIdParam, {
      siteColumns: "id, niche, target_audiences",
    });
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

  // Ownership was verified above through the signed-in user's project/site
  // lookup. Use service role for the actual queue reset so child-row RLS
  // cannot make this look like a successful no-op.
  const svc = serviceClient();
  const { error: delErr, count } = await svc
    .from("lx_keyword")
    .delete({ count: "exact" })
    .eq("site_id", lxSiteId)
    .in("status", ["queued", "failed", "generating"]);
  if (delErr) {
    return NextResponse.json(
      { ok: false, error: `delete failed: ${delErr.message}` },
      { status: 500 },
    );
  }

  await enqueueKeywordResearch(lxSiteId);

  return NextResponse.json({ ok: true, deleted: count ?? 0 });
}
