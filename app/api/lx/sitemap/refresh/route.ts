import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enqueueSitemapCrawl } from "@/lib/lx/workerClient";
import { getCurrentSite, getProjectById } from "@/lib/lx/currentSite";

export const runtime = "nodejs";

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
      | { id: string; lx_site_id: string | null }
      | null;
    if (!site) {
      return NextResponse.json(
        { ok: false, error: "no site configured" },
        { status: 404 },
      );
    }
    lxSiteId = site.lx_site_id;
  }
  if (!lxSiteId) {
    return NextResponse.json(
      { ok: false, error: "autoblog not configured for this project" },
      { status: 400 },
    );
  }

  // Mark queued so the dashboard reflects state immediately; worker flips
  // to 'crawling' when it picks up.
  await supabase
    .from("lx_site")
    .update({ sitemap_status: "queued" })
    .eq("id", lxSiteId);

  await enqueueSitemapCrawl(lxSiteId);
  return NextResponse.json({ ok: true });
}
