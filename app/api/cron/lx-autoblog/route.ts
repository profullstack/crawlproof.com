import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { nextPublishAt } from "@/lib/lx/schedule";
import {
  enqueueArticleGenerate,
  enqueueKeywordResearch,
} from "@/lib/lx/workerClient";
import { repairStuckLxJobs } from "@/lib/lx/repair";

export const runtime = "nodejs";

// Keep at least this many queued keywords on each active site. Once the
// queue drops below the threshold the cron fires keyword research to
// top it up, so autoblog runs autonomously past the initial 30-day
// seed. Tuned so a daily 1-article-per-day site never goes dark — at 14
// remaining we have a 2-week buffer to refill before the worker runs dry.
const KEYWORD_TOPUP_THRESHOLD = 14;

export async function GET(req: Request) {
  return POST(req);
}

export async function POST(req: Request) {
  const incoming =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (incoming !== env.cronSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const svc = serviceClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const repaired = await repairStuckLxJobs(svc, { now });

  // ============================================================
  // Pass 1: top up keywords on every active site whose queued
  // count is below the threshold. Runs before the publish-due
  // sweep so a freshly-refilled site can publish on the same
  // tick if needed. researchKeywords dedupes against existing
  // rows so re-running is safe.
  // ============================================================
  const { data: activeSites, error: actErr } = await svc
    .from("lx_site")
    .select("id")
    .eq("status", "active")
    .not("webhook_url", "is", null);
  if (actErr) {
    return NextResponse.json({ ok: false, error: actErr.message }, { status: 500 });
  }
  let topped_up = 0;
  for (const s of activeSites ?? []) {
    const { count } = await svc
      .from("lx_keyword")
      .select("id", { count: "exact", head: true })
      .eq("site_id", s.id as string)
      .eq("status", "queued");
    if ((count ?? 0) < KEYWORD_TOPUP_THRESHOLD) {
      await enqueueKeywordResearch(s.id as string);
      topped_up++;
    }
  }

  // ============================================================
  // Pass 2: find every active site whose next publish slot has
  // arrived. Sites without a webhook are skipped — there's
  // nowhere for the article to land.
  // ============================================================
  const { data: due, error } = await svc
    .from("lx_site")
    .select(
      "id, publish_days, publish_hour, webhook_url, next_publish_at",
    )
    .eq("status", "active")
    .not("webhook_url", "is", null)
    .lt("next_publish_at", nowIso)
    .limit(100);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  let enqueued = 0;
  let skipped_no_webhook = 0;

  for (const s of due ?? []) {
    if (!s.webhook_url) {
      skipped_no_webhook++;
      continue;
    }
    // Advance the schedule pointer BEFORE enqueueing, so a crash in the
    // worker can't loop us on the same slot. The worker idempotently
    // picks the next queued keyword anyway.
    const next = nextPublishAt(
      s.publish_days as number[],
      s.publish_hour as number,
      now,
    );
    await svc
      .from("lx_site")
      .update({ next_publish_at: next?.toISOString() ?? null })
      .eq("id", s.id);

    await enqueueArticleGenerate(s.id);
    enqueued++;
  }

  return NextResponse.json({
    ok: true,
    repaired,
    topped_up,
    enqueued,
    skipped_no_webhook,
  });
}
