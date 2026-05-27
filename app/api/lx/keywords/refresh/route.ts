import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enqueueKeywordResearch } from "@/lib/lx/workerClient";
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
  let niche: string | null = null;
  let targetAudiences: string[] = [];
  let seedKeywords: string[] = [];
  let savedKeywords: string[] = [];
  if (projectIdParam) {
    const project = await getProjectById(projectIdParam, {
      siteColumns: "id, niche, target_audiences, seed_keywords, keywords",
    });
    const lxSite = project?.lx_site as
      | {
          id?: string;
          niche?: string | null;
          target_audiences?: string[];
          seed_keywords?: string[];
          keywords?: string[];
        }
      | null;
    lxSiteId = lxSite?.id ?? null;
    niche = lxSite?.niche ?? null;
    targetAudiences = lxSite?.target_audiences ?? [];
    seedKeywords = lxSite?.seed_keywords ?? [];
    savedKeywords = lxSite?.keywords ?? [];
  } else {
    const site = (await getCurrentSite("id, niche, target_audiences, seed_keywords, keywords")) as
      | {
          id: string;
          niche: string | null;
          target_audiences: string[];
          seed_keywords: string[];
          keywords: string[];
          lx_site_id: string | null;
        }
      | null;
    if (!site) {
      return NextResponse.json(
        { ok: false, error: "no site configured" },
        { status: 404 },
      );
    }
    lxSiteId = site.lx_site_id;
    niche = site.niche;
    targetAudiences = site.target_audiences ?? [];
    seedKeywords = site.seed_keywords ?? [];
    savedKeywords = site.keywords ?? [];
  }
  if (!lxSiteId) {
    return NextResponse.json(
      { ok: false, error: "autoblog not configured for this project" },
      { status: 400 },
    );
  }
  if (
    !niche &&
    targetAudiences.length === 0 &&
    seedKeywords.length === 0 &&
    savedKeywords.length === 0
  ) {
    return NextResponse.json(
      { ok: false, error: "add saved keywords or seed keywords before generating keywords" },
      { status: 400 },
    );
  }

  const queued = await enqueueKeywordResearch(lxSiteId);
  if (!queued.ok) {
    return NextResponse.json(
      { ok: false, error: queued.error },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, message: "Keyword research queued." });
}
