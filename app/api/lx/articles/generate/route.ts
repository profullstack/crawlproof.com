import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  enqueueArticleGenerate,
  enqueueKeywordResearch,
} from "@/lib/lx/workerClient";
import { getProjectById, getCurrentSite } from "@/lib/lx/currentSite";
import { repairStuckLxJobs } from "@/lib/lx/repair";
import { serviceClient } from "@/lib/supabase/service";
import { getArticleGenerationCapacity } from "@/lib/autopilot/entitlements";

export const runtime = "nodejs";

// Manually queue an article generation. Site resolution: prefer
// ?projectId from the caller (the dashboard knows the project from the
// URL) so users with multiple projects can't accidentally generate for
// the wrong one when the picker cookie drifts.
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
  let projectId: string | null = null;
  let ownerId = user.id;
  let siteStatus: string | null = null;
  if (projectIdParam) {
    const project = await getProjectById(projectIdParam, {
      projectColumns: "id, name, url, owner_id",
      siteColumns: "id, project_id, status",
    });
    const lxSite = project?.lx_site as {
      id?: string;
      project_id?: string;
      status?: string;
    } | null;
    lxSiteId = lxSite?.id ?? null;
    projectId = lxSite?.project_id ?? null;
    ownerId = (project as { owner_id?: string } | null)?.owner_id ?? user.id;
    siteStatus = lxSite?.status ?? null;
  } else {
    const site = (await getCurrentSite("id, status")) as
      | {
          id: string;
          status: string;
          lx_site_id: string | null;
          project_id?: string | null;
        }
      | null;
    lxSiteId = site?.lx_site_id ?? null;
    projectId = site?.project_id ?? site?.id ?? null;
    siteStatus = site?.status ?? null;
  }
  if (!lxSiteId) {
    return NextResponse.json(
      { ok: false, error: "autoblog not configured for this project" },
      { status: 400 },
    );
  }
  if (siteStatus !== "active") {
    return NextResponse.json(
      { ok: false, error: `site is ${siteStatus ?? "unknown"}` },
      { status: 400 },
    );
  }

  // Cheap upfront check so the UI surfaces "out of quota / credits"
  // instead of silently no-op'ing in the worker. The worker still
  // re-checks atomically via consume_article_generation before
  // generation begins.
  if (!projectId) {
    return NextResponse.json(
      { ok: false, error: "project not resolved for this autoblog site" },
      { status: 400 },
    );
  }
  const svc = serviceClient();
  const capacity = await getArticleGenerationCapacity(svc, projectId, ownerId);
  if (!capacity.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "Out of included articles and credits. Buy more credits or renew Autopilot to generate articles.",
        credits_balance: capacity.creditsBalance,
        article_entitlement: capacity.entitlement,
      },
      { status: 402 },
    );
  }

  await repairStuckLxJobs(svc, { siteId: lxSiteId });
  const { count: queuedCount } = await svc
    .from("lx_keyword")
    .select("id", { count: "exact", head: true })
    .eq("site_id", lxSiteId)
    .eq("status", "queued");
  if ((queuedCount ?? 0) === 0) {
    const queued = await enqueueKeywordResearch(lxSiteId);
    if (!queued.ok) {
      return NextResponse.json(
        { ok: false, error: queued.error },
        { status: 503 },
      );
    }
    return NextResponse.json({
      ok: true,
      action: "keyword_research",
      message:
        "No queued keywords were available, so keyword research was started. The article button will produce a preview after research finishes.",
    });
  }

  // The button is a manual "generate now" — bypass the cron's
  // scheduled_for filter so it actually produces something when the
  // earliest queued slot is in the future. Default behavior (preview=true)
  // leaves the article in 'ready' state for review before publish.
  const queued = await enqueueArticleGenerate(lxSiteId, {
    manual: true,
    preview: true,
  });
  if (!queued.ok) {
    return NextResponse.json(
      { ok: false, error: queued.error },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, message: "Article generation queued." });
}
