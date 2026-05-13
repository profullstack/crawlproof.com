"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { refundCredit } from "@/lib/rateLimit";
import { ENGINES, type Engine } from "@/lib/credits";

type Ok = { ok: true; abortedCount: number; refundedCredits: number };
type Err = { ok: false; error: string };

// Cancel every queued / running audit in a scan run, mark it failed with
// reason "Aborted by user", and refund the credits that were spent on
// engines that didn't complete. The worker checks aborted_at IS NULL on
// every write so late completions from in-flight API calls no-op.
export async function abortScanRun(input: {
  projectId: string;
  runId: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // Owner gate via the project; service client below to flip rows.
  const { data: project } = await supabase
    .from("projects")
    .select("id, owner_id")
    .eq("id", input.projectId)
    .maybeSingle();
  if (!project || project.owner_id !== user.id) {
    return { ok: false, error: "Not found." };
  }

  const svc = serviceClient();
  const { data: pending } = await svc
    .from("audits")
    .select("id, engine, status")
    .eq("scan_run_id", input.runId)
    .eq("project_id", input.projectId)
    .in("status", ["queued", "running"])
    .is("aborted_at", null);
  const rows = (pending ?? []) as { id: string; engine: Engine; status: string }[];
  if (rows.length === 0) {
    return { ok: true, abortedCount: 0, refundedCredits: 0 };
  }

  const now = new Date().toISOString();
  const ids = rows.map((r) => r.id);
  await svc
    .from("audits")
    .update({
      status: "failed",
      failed_reason: "Aborted by user",
      aborted_at: now,
      completed_at: now,
    })
    .in("id", ids);

  // Refund credits only for paid engines we hadn't already charged a
  // failed completion for. Rule engine is free.
  const refundedCredits = rows.reduce(
    (sum, r) => sum + (ENGINES[r.engine]?.cost ?? 0),
    0,
  );
  if (refundedCredits > 0) {
    await refundCredit(user.id, refundedCredits);
  }

  revalidatePath(`/projects/${input.projectId}/runs/${input.runId}`);
  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, abortedCount: rows.length, refundedCredits };
}
