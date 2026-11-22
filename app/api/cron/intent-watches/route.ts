import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { runIntentWatch, type IntentWatch } from "@/lib/intent/run";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Watches run per tick. Each is up to ~12 SERP calls; keep a tick inside maxDuration. */
const PER_TICK = 8;

export async function GET(req: Request) {
  return POST(req);
}

/** Runs every active Buyer Intent watch whose next_run_at has passed. */
export async function POST(req: Request) {
  const incoming =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (incoming !== env.cronSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const svc = serviceClient();
  const { data, error } = await svc
    .from("intent_watches")
    .select("*")
    .eq("active", true)
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .limit(PER_TICK);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const results: Array<Record<string, unknown>> = [];
  for (const w of (data ?? []) as IntentWatch[]) {
    try {
      const r = await runIntentWatch(svc, w);
      results.push({ id: w.id, ...(r.ok ? { ok: true, found: r.found, inserted: r.inserted } : { ok: false, error: r.error }) });
    } catch (err) {
      results.push({ id: w.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return NextResponse.json({ ok: true, ran: results.length, results });
}
