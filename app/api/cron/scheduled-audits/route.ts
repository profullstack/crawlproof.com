import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { newShareToken } from "@/lib/shareToken";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return POST(req);
}

export async function POST(req: Request) {
  // Both Vercel cron and our pg_cron use a shared secret header.
  const incoming =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (incoming !== env.cronSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const svc = serviceClient();
  const now = new Date().toISOString();

  const { data: due, error } = await svc
    .from("projects")
    .select("id, owner_id, url, schedule")
    .neq("schedule", "off")
    .lt("next_run_at", now)
    .limit(100);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  let enqueued = 0;
  for (const p of due ?? []) {
    const token = newShareToken();
    const { data: row } = await svc
      .from("audits")
      .insert({
        target_url: p.url,
        project_id: p.id,
        owner_id: p.owner_id,
        status: "queued",
        share_token: token,
      })
      .select("id")
      .single();
    if (!row) continue;

    const nextRun = new Date(
      Date.now() + (p.schedule === "weekly" ? 7 : 30) * 24 * 60 * 60 * 1000,
    ).toISOString();
    await svc.from("projects").update({ next_run_at: nextRun }).eq("id", p.id);

    if (env.workerUrl) {
      fetch(`${env.workerUrl}/enqueue`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": env.workerSecret },
        body: JSON.stringify({ auditId: row.id }),
      }).catch(() => {});
    }
    enqueued++;
  }
  return NextResponse.json({ ok: true, enqueued });
}
