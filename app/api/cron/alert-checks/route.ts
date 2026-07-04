import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";

export const runtime = "nodejs";

// pg_cron hits this every 10 minutes. We select alerts whose next_run_at has
// passed, group them by owner, and hand each owner off to the worker as a
// single job — so all of one user's due alerts are polled together and land in
// ONE batched digest. Global kill-switch: cron_config key 'alerts_enabled'.

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

  // Kill-switch: any value other than 'false' (or an absent row) = enabled.
  const { data: killRow } = await svc
    .from("cron_config")
    .select("value")
    .eq("key", "alerts_enabled")
    .maybeSingle();
  if (killRow && String(killRow.value).toLowerCase() === "false") {
    return NextResponse.json({ ok: true, disabled: true, enqueued: 0 });
  }

  if (!env.workerUrl || !env.workerSecret) {
    return NextResponse.json({ ok: false, error: "worker not configured" }, { status: 500 });
  }

  const now = new Date().toISOString();
  const { data: due, error } = await svc
    .from("alerts")
    .select("id, owner_id")
    .eq("status", "active")
    .lt("next_run_at", now)
    .order("next_run_at", { ascending: true })
    .limit(500);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const byOwner = new Map<string, string[]>();
  for (const a of (due ?? []) as { id: string; owner_id: string }[]) {
    const list = byOwner.get(a.owner_id) ?? [];
    list.push(a.id);
    byOwner.set(a.owner_id, list);
  }

  let enqueued = 0;
  for (const [ownerId, alertIds] of byOwner) {
    // Fire-and-forget; the worker responds 202 immediately and processes async.
    fetch(`${env.workerUrl}/alerts/check-user`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": env.workerSecret },
      body: JSON.stringify({ ownerId, alertIds }),
    }).catch((e) => console.error("[cron alert-checks] enqueue failed", e));
    enqueued++;
  }

  return NextResponse.json({ ok: true, owners: enqueued, alerts: due?.length ?? 0 });
}
