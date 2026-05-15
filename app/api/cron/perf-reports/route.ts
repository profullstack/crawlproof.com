import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import {
  aggregatePerfReport,
  isReportDue,
  sendPerfReportEmail,
  type Cadence,
} from "@/lib/perfReport";

export const runtime = "nodejs";

// Bound per-tick send count so a slow Resend response can't tie up the
// request past the cron's expectation. Most ticks send 0 messages
// (only the user's local Mon 09:00 / 1st 09:00 tick is eligible).
const MAX_PER_TICK = 50;

type ProfileRow = {
  id: string;
  email: string;
  perf_report_cadence: "off" | "weekly" | "monthly";
  timezone: string;
  perf_report_last_sent_at: string | null;
};

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

  const { data: rows, error } = await svc
    .from("profiles")
    .select(
      "id, email, perf_report_cadence, timezone, perf_report_last_sent_at",
    )
    .neq("perf_report_cadence", "off")
    .not("email", "is", null)
    .limit(1000);
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  let sent = 0;
  let skipped_not_due = 0;
  let failed = 0;
  for (const r of (rows ?? []) as ProfileRow[]) {
    if (sent >= MAX_PER_TICK) break;

    const lastSentAt = r.perf_report_last_sent_at
      ? new Date(r.perf_report_last_sent_at)
      : null;
    const due = isReportDue(
      r.perf_report_cadence as Cadence,
      r.timezone ?? "UTC",
      now,
      lastSentAt,
    );
    if (!due) {
      skipped_not_due++;
      continue;
    }

    try {
      const report = await aggregatePerfReport(
        svc,
        r.id,
        r.perf_report_cadence as Cadence,
        now,
      );
      if (!report) {
        skipped_not_due++;
        continue;
      }
      const result = await sendPerfReportEmail(r.email, report);
      if (!result.ok) {
        failed++;
        console.warn(`[perf-reports] send failed user=${r.id}: ${result.error}`);
        continue;
      }
      // Claim AFTER successful send so a failure leaves us eligible to
      // retry on the next hourly tick (which only re-eligibilizes if
      // the user's local 09:00 falls again, i.e. typically next week).
      // For weekly that's the right behavior; a one-tick miss just
      // skips this week.
      await svc
        .from("profiles")
        .update({ perf_report_last_sent_at: now.toISOString() })
        .eq("id", r.id);
      sent++;
    } catch (err) {
      failed++;
      console.error(`[perf-reports] crashed user=${r.id}`, err);
    }
  }

  return NextResponse.json({
    ok: true,
    candidates: rows?.length ?? 0,
    sent,
    skipped_not_due,
    failed,
  });
}
