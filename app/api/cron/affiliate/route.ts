// Hourly: approve conversions past their hold (or reverse the refunded),
// deliver queued webhooks, pay on the weekly schedule, re-read stale
// merchants and stale ledgers. Gated on CRON_SECRET like every cron route.
import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { approveDue } from "@/lib/affiliate/attribution";
import { deliverDue } from "@/lib/affiliate/webhooks";
import { runScheduledPayouts } from "@/lib/affiliate/payouts";
import { refreshStale, syncStaleJoins } from "@/lib/affiliate/directory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  return POST(req);
}

export async function POST(req: Request) {
  const incoming = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!env.cronSecret || incoming !== env.cronSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const svc = serviceClient();
  const out: Record<string, unknown> = { ok: true };
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["approved", () => approveDue(svc)],
    ["webhooks", () => deliverDue(svc)],
    ["payouts", () => runScheduledPayouts(svc)],
    ["directory", () => refreshStale(svc)],
    ["joins", () => syncStaleJoins(svc)],
  ];
  for (const [name, run] of steps) {
    try {
      out[name] = await run();
    } catch (err) {
      out[name] = { error: err instanceof Error ? err.message : String(err) };
      console.error(`[affiliate cron] ${name}`, err);
    }
  }
  return NextResponse.json(out);
}
