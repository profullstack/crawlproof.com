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
  let skipped_no_credits = 0;
  for (const p of due ?? []) {
    // Each scheduled run costs 1 credit. Skip the project if the owner is out;
    // we still bump next_run_at so it doesn't pile up.
    const { data: ok } = await svc.rpc("consume_credit", { p_owner: p.owner_id });
    const nextRun = new Date(
      Date.now() + (p.schedule === "weekly" ? 7 : 30) * 24 * 60 * 60 * 1000,
    ).toISOString();

    if (!ok) {
      skipped_no_credits++;
      await svc.from("projects").update({ next_run_at: nextRun }).eq("id", p.id);
      continue;
    }

    const token = newShareToken();
    const { data: row } = await svc
      .from("audits")
      .insert({
        target_url: p.url,
        project_id: p.id,
        owner_id: p.owner_id,
        status: "queued",
        share_token: token,
        triggered_by: "scheduled",
      })
      .select("id")
      .single();
    if (!row) {
      // Refund the credit if we couldn't insert.
      const { data: prof } = await svc
        .from("profiles")
        .select("credits_balance")
        .eq("id", p.owner_id)
        .maybeSingle();
      if (prof) {
        await svc
          .from("profiles")
          .update({ credits_balance: (prof.credits_balance ?? 0) + 1 })
          .eq("id", p.owner_id);
      }
      continue;
    }

    await svc.from("projects").update({ next_run_at: nextRun }).eq("id", p.id);

    await svc.from("usage_events").insert({
      owner_id: p.owner_id,
      kind: "audit_run",
      audit_id: row.id,
      meta: { from: "cron", credit_spent: true, schedule: p.schedule },
    });

    if (env.workerUrl) {
      fetch(`${env.workerUrl}/enqueue`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": env.workerSecret },
        body: JSON.stringify({ auditId: row.id }),
      }).catch(() => {});
    }
    enqueued++;
  }
  return NextResponse.json({ ok: true, enqueued, skipped_no_credits });
}
