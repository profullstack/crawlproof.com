import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { nextPublishAt } from "@/lib/lx/schedule";
import { enqueueArticleGenerate } from "@/lib/lx/workerClient";

export const runtime = "nodejs";

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

  // Find every active site whose next publish slot has arrived. Sites
  // without a webhook configured are skipped — there's nowhere for the
  // article to land.
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

  return NextResponse.json({ ok: true, enqueued, skipped_no_webhook });
}
