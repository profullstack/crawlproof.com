import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { newShareToken } from "@/lib/shareToken";
import { buildShareCard } from "@/lib/audit/share-card";
import { sendWatchChangeEmail } from "@/lib/email";
import { getProspectsOrgId } from "@/lib/orgs";
import { nextRunAt, watchSubject, watchVerdict, type WatchCadence } from "@/lib/watches";
import { env } from "@/lib/env";

export const runtime = "nodejs";

const ENQUEUE_BATCH = 50;
const DELIVER_BATCH = 100;

type WatchRow = {
  id: string;
  email: string;
  target_url: string;
  engine: string;
  cadence: string;
  unsubscribe_token: string;
  pending_audit_id: string | null;
  last_score: number | null;
};

export async function GET(req: Request) {
  return POST(req);
}

/**
 * One tick does two things, in this order:
 *
 *   1. DELIVER — a re-scan enqueued on an earlier tick has finished, so
 *      compare it to the stored baseline and email only if it really moved.
 *   2. ENQUEUE — start re-scans whose cadence has come due.
 *
 * Deliver runs first so a scan that finished since the last tick is reported
 * before that watch is considered for its next run.
 */
export async function POST(req: Request) {
  const incoming =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (incoming !== env.cronSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const svc = serviceClient();
  const base = env.siteUrl.replace(/\/$/, "");
  const now = new Date();

  let delivered = 0;
  let unchanged = 0;
  let scan_failed = 0;
  let enqueued = 0;

  // ---- 1. Deliver finished re-scans -------------------------------------
  const { data: pending } = await svc
    .from("scan_watches")
    .select("id, email, target_url, engine, cadence, unsubscribe_token, pending_audit_id, last_score")
    .not("pending_audit_id", "is", null)
    .is("unsubscribed_at", null)
    .limit(DELIVER_BATCH);

  for (const w of (pending ?? []) as WatchRow[]) {
    const { data: audit } = await svc
      .from("audits")
      .select("target_url, status, score, engine, summary, share_token")
      .eq("id", w.pending_audit_id!)
      .maybeSingle();

    // Row vanished — clear the pointer so the watch isn't wedged forever.
    if (!audit) {
      await svc.from("scan_watches").update({ pending_audit_id: null }).eq("id", w.id);
      continue;
    }
    if (audit.status === "queued" || audit.status === "running") continue;

    if (audit.status !== "complete") {
      // A failed scan is our problem, not news for the subscriber. Clear it
      // and let the next cadence tick try again.
      scan_failed++;
      await svc
        .from("scan_watches")
        .update({ pending_audit_id: null, last_scanned_at: now.toISOString() })
        .eq("id", w.id);
      continue;
    }

    const card = buildShareCard(audit as Parameters<typeof buildShareCard>[0]);
    if (card.score === null) {
      await svc.from("scan_watches").update({ pending_audit_id: null }).eq("id", w.id);
      continue;
    }

    const verdict = watchVerdict({
      engineKind: card.kind,
      previousScore: w.last_score,
      nextScore: card.score,
    });

    const update: Record<string, unknown> = {
      pending_audit_id: null,
      last_scanned_at: now.toISOString(),
      // Re-baseline on every completed scan, notified or not. Otherwise a
      // series of sub-threshold drifts would never add up to an email, and
      // then one day report a jump that never happened in one step.
      last_score: card.score,
    };

    if (verdict.notify) {
      const res = await sendWatchChangeEmail({
        to: w.email,
        subject: watchSubject({
          host: card.host,
          label: card.label,
          score: card.score,
          verdict,
        }),
        host: card.host,
        label: card.label,
        score: card.score,
        previousScore: w.last_score,
        improved: verdict.improved,
        first: verdict.kind === "first",
        scaleHint: card.scaleHint,
        reportUrl: `${base}/r/${audit.share_token}`,
        // The API URL, not the page: RFC 8058 requires List-Unsubscribe and
        // List-Unsubscribe-Post to name the same URL, and only the route
        // handler can answer the client's POST. A human clicking it gets
        // redirected to the page.
        stopUrl: `${base}/api/watch/stop/${w.unsubscribe_token}`,
        cadence: w.cadence,
      });
      if (res.sent) {
        update.last_notified_at = now.toISOString();
        delivered++;
      }
    } else {
      unchanged++;
    }

    await svc.from("scan_watches").update(update).eq("id", w.id);
  }

  // ---- 2. Enqueue due re-scans ------------------------------------------
  const { data: due, error } = await svc
    .from("scan_watches")
    .select("id, email, target_url, engine, cadence, unsubscribe_token, pending_audit_id, last_score")
    .not("verified_at", "is", null)
    .is("unsubscribed_at", null)
    .is("pending_audit_id", null)
    .lt("next_run_at", now.toISOString())
    .limit(ENQUEUE_BATCH);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // Watch scans are anonymous by design (no account behind them), so tag them
  // to the Prospects org — the same bucket the hero form's anonymous scans go
  // to, which is what makes them workable from /recent.
  const prospectsOrgId = await getProspectsOrgId().catch(() => null);

  for (const w of (due ?? []) as WatchRow[]) {
    const next = nextRunAt(w.cadence as WatchCadence, now).toISOString();

    const { data: row, error: insErr } = await svc
      .from("audits")
      .insert({
        target_url: w.target_url,
        owner_id: null,
        organization_id: prospectsOrgId,
        status: "queued",
        share_token: newShareToken(),
        triggered_by: "watch",
        engine: w.engine,
      })
      .select("id")
      .maybeSingle();

    if (insErr || !row) {
      // Push the schedule out anyway so one bad row can't be retried every
      // tick forever.
      await svc.from("scan_watches").update({ next_run_at: next }).eq("id", w.id);
      continue;
    }

    await svc
      .from("scan_watches")
      .update({ pending_audit_id: row.id, next_run_at: next })
      .eq("id", w.id);

    if (env.workerUrl) {
      fetch(`${env.workerUrl}/enqueue`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-secret": env.workerSecret,
        },
        body: JSON.stringify({ auditId: row.id }),
      }).catch(() => {});
    }
    enqueued++;
  }

  return NextResponse.json({ ok: true, delivered, unchanged, scan_failed, enqueued });
}
