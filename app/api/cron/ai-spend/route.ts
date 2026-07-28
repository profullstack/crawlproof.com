import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { formatUsd, spendToday, MICROS_PER_DOLLAR } from "@/lib/ai/spend";
import { sendAiSpendAlertEmail } from "@/lib/email";

export const runtime = "nodejs";

/**
 * Warn when a day's AI spend crosses the threshold. It only warns — nothing
 * here throttles, pauses or blocks a request. A budget alarm that silently
 * turns the product off is worse than the bill it was meant to prevent.
 *
 * Run it hourly. The alert de-duplicates on (day, threshold), so a day that
 * crosses the line mails once rather than on every run after it.
 *
 * The balance on the Anthropic account is deliberately not reported: reading
 * it needs an Admin key (sk-ant-admin01-...), and a normal API key gets a 401
 * on the cost and usage endpoints. What this can measure exactly is what this
 * application spent, which is the number the alert is actually about.
 */
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

  const thresholdMicros = Math.round(env.aiSpendDailyAlertUsd * MICROS_PER_DOLLAR);
  const spend = await spendToday();
  const over = spend.totalMicros >= thresholdMicros;

  if (!over) {
    return NextResponse.json({
      ok: true,
      day: spend.day,
      spend: formatUsd(spend.totalMicros),
      threshold: formatUsd(thresholdMicros),
      alerted: false,
    });
  }

  const sb = serviceClient();
  // Insert first and let the unique index decide. Checking-then-sending would
  // mail twice if two runs overlap.
  const { error: claimError } = await sb.from("ai_spend_alerts").insert({
    day: spend.day,
    threshold_micros: thresholdMicros,
    spend_micros: spend.totalMicros,
    sent_to: env.aiSpendAlertEmail,
  });
  if (claimError) {
    // Already alerted for this day and threshold.
    return NextResponse.json({
      ok: true,
      day: spend.day,
      spend: formatUsd(spend.totalMicros),
      alerted: false,
      note: "already alerted today",
    });
  }

  await sendAiSpendAlertEmail({
    to: env.aiSpendAlertEmail,
    day: spend.day,
    spendLabel: formatUsd(spend.totalMicros),
    thresholdLabel: formatUsd(thresholdMicros),
    calls: spend.calls,
    breakdown: spend.byFeature.map((f) => ({
      feature: f.feature,
      spendLabel: formatUsd(f.micros),
      calls: f.calls,
    })),
  });

  return NextResponse.json({
    ok: true,
    day: spend.day,
    spend: formatUsd(spend.totalMicros),
    threshold: formatUsd(thresholdMicros),
    alerted: true,
  });
}
