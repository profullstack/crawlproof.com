"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { consumeCredit, refundCredit } from "@/lib/rateLimit";
import { ENGINES, type Engine } from "@/lib/credits";
import { env } from "@/lib/env";

type Ok = { ok: true };
type Err = { ok: false; error: string };

/**
 * Cancel one in-flight or queued audit. Mirrors abortScanRun but scoped
 * to a single audit row instead of an entire run, so users can drop the
 * laggard engine without nuking the whole multi-engine fan-out.
 *
 * Refunds the engine's credit cost (rule is free). The worker checks
 * aborted_at IS NULL on every write so late completions from in-flight
 * API calls become no-ops.
 */
export async function abortAudit(input: {
  projectId: string;
  auditId: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: project } = await supabase
    .from("projects")
    .select("id, owner_id")
    .eq("id", input.projectId)
    .maybeSingle();
  if (!project || project.owner_id !== user.id) {
    return { ok: false, error: "Not found." };
  }

  const svc = serviceClient();
  const { data: audit } = await svc
    .from("audits")
    .select("id, engine, status, project_id, scan_run_id, aborted_at")
    .eq("id", input.auditId)
    .eq("project_id", input.projectId)
    .maybeSingle();
  if (!audit) return { ok: false, error: "Not found." };
  if (audit.aborted_at) return { ok: false, error: "Already aborted." };
  if (audit.status !== "queued" && audit.status !== "running") {
    return {
      ok: false,
      error: `Audit is '${audit.status}' — only queued/running can be aborted.`,
    };
  }

  const now = new Date().toISOString();
  const { error: updErr } = await svc
    .from("audits")
    .update({
      status: "failed",
      failed_reason: "Aborted by user",
      aborted_at: now,
      completed_at: now,
    })
    .eq("id", input.auditId)
    .is("aborted_at", null);
  if (updErr) return { ok: false, error: updErr.message };

  const refund = ENGINES[audit.engine as Engine]?.cost ?? 0;
  if (refund > 0) await refundCredit(user.id, refund);

  revalidatePath(`/projects/${input.projectId}/runs/${audit.scan_run_id}`);
  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true };
}

/**
 * Re-queue a failed audit (natural failure OR user-aborted). Both
 * failure paths refund the credit, so retry always re-charges before
 * re-queueing. Clears aborted_at and failed_reason so the row looks
 * like a fresh attempt.
 */
export async function retryAudit(input: {
  projectId: string;
  auditId: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: project } = await supabase
    .from("projects")
    .select("id, owner_id")
    .eq("id", input.projectId)
    .maybeSingle();
  if (!project || project.owner_id !== user.id) {
    return { ok: false, error: "Not found." };
  }

  const svc = serviceClient();
  const { data: audit } = await svc
    .from("audits")
    .select("id, engine, status, scan_run_id, aborted_at, failed_reason")
    .eq("id", input.auditId)
    .eq("project_id", input.projectId)
    .maybeSingle();
  if (!audit) return { ok: false, error: "Not found." };
  if (audit.status !== "failed") {
    return {
      ok: false,
      error: `Audit is '${audit.status}' — only failed audits can be retried.`,
    };
  }

  // Both failure paths refund: worker auto-refunds natural failures,
  // abortAudit refunds user-aborted ones. So retry always re-charges.
  // Rule engine is free.
  const cost = ENGINES[audit.engine as Engine]?.cost ?? 0;
  if (cost > 0) {
    const charged = await consumeCredit(user.id, cost);
    if (!charged.ok) {
      return {
        ok: false,
        error: `Not enough credits to retry this engine (${cost} required).`,
      };
    }
  }

  const { error: resetErr } = await svc
    .from("audits")
    .update({
      status: "queued",
      failed_reason: null,
      completed_at: null,
      aborted_at: null,
      score: null,
      summary: null,
      report_markdown: null,
    })
    .eq("id", input.auditId)
    .eq("status", "failed");
  if (resetErr) {
    // Refund the credit we just spent — the reset didn't take.
    if (cost > 0) await refundCredit(user.id, cost);
    return { ok: false, error: resetErr.message };
  }

  // Fire-and-forget worker ping; the sweep loop will pick this up
  // anyway if the HTTP enqueue misses.
  if (env.workerUrl) {
    try {
      await fetch(`${env.workerUrl}/enqueue`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-secret": env.workerSecret,
        },
        body: JSON.stringify({ auditId: input.auditId }),
      });
    } catch (err) {
      console.warn("[retryAudit] worker notify failed; sweep will recover", err);
    }
  }

  revalidatePath(`/projects/${input.projectId}/runs/${audit.scan_run_id}`);
  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true };
}
