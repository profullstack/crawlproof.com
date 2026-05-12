import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { newShareToken } from "@/lib/shareToken";
import {
  dedupeEngines,
  engineAvailable,
  selectionCost,
  type Engine,
} from "@/lib/credits";
import { env } from "@/lib/env";

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
  const now = new Date().toISOString();

  const { data: due, error } = await svc
    .from("projects")
    .select("id, owner_id, url, schedule, engines")
    .neq("schedule", "off")
    .lt("next_run_at", now)
    .limit(100);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  let enqueued = 0;
  let skipped_no_credits = 0;
  let skipped_no_engines = 0;

  for (const p of due ?? []) {
    // Read the project's CURRENT engine list — user edits flow through here.
    const engines: Engine[] = dedupeEngines(
      ((p.engines as Engine[] | null) ?? ["rule"]).filter((e) => engineAvailable(e)),
    );
    const nextRun = new Date(
      Date.now() + (p.schedule === "weekly" ? 7 : 30) * 24 * 60 * 60 * 1000,
    ).toISOString();

    if (engines.length === 0) {
      skipped_no_engines++;
      await svc.from("projects").update({ next_run_at: nextRun }).eq("id", p.id);
      continue;
    }

    const cost = selectionCost(engines);
    if (cost > 0) {
      const { data: ok } = await svc.rpc("consume_credit", {
        p_owner: p.owner_id,
        p_count: cost,
      });
      if (!ok) {
        skipped_no_credits++;
        await svc.from("projects").update({ next_run_at: nextRun }).eq("id", p.id);
        continue;
      }
    }

    // One audit row per engine.
    const inserts = engines.map((e) => ({
      target_url: p.url,
      project_id: p.id,
      owner_id: p.owner_id,
      status: "queued",
      share_token: newShareToken(),
      triggered_by: "scheduled",
      engine: e,
    }));
    const { data: rows, error: insErr } = await svc
      .from("audits")
      .insert(inserts)
      .select("id, engine");

    if (insErr || !rows) {
      // Refund the lot.
      if (cost > 0) {
        const { data: prof } = await svc
          .from("profiles")
          .select("credits_balance")
          .eq("id", p.owner_id)
          .maybeSingle();
        if (prof) {
          await svc
            .from("profiles")
            .update({ credits_balance: (prof.credits_balance ?? 0) + cost })
            .eq("id", p.owner_id);
        }
      }
      continue;
    }

    await svc.from("projects").update({ next_run_at: nextRun }).eq("id", p.id);

    for (const r of rows) {
      await svc.from("usage_events").insert({
        owner_id: p.owner_id,
        kind: "audit_run",
        audit_id: r.id,
        meta: { from: "cron", schedule: p.schedule, engine: r.engine },
      });
      if (env.workerUrl) {
        fetch(`${env.workerUrl}/enqueue`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-worker-secret": env.workerSecret,
          },
          body: JSON.stringify({ auditId: r.id }),
        }).catch(() => {});
      }
      enqueued++;
    }
  }
  return NextResponse.json({
    ok: true,
    enqueued,
    skipped_no_credits,
    skipped_no_engines,
  });
}
