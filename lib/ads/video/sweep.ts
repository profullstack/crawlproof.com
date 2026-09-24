// Drain render jobs whose BullMQ job never materialised.
//
// ad_video_jobs is the durable record and the BullMQ job is the transient work
// item, which is the right way round — but it leaves a gap. If Redis is down
// when a campaign is saved, or the process dies between the insert and the
// enqueue, the row sits `queued` with nothing scheduled to look at it. Several
// comments in this package promise "a sweep can pick it up"; this is that
// sweep, and without it those rows are simply lost.
//
// It also makes a backfill trivial: a script can insert rows and let the sweep
// schedule them, instead of needing to reach Redis itself from wherever it runs.

import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueRender, getVideoRenderQueue, renderJobId } from "./queue";
import type { VideoDesignSnapshot } from "./snapshot";
import type { VideoProfileId } from "./profiles";

/**
 * Grace period before a queued row is considered stranded.
 *
 * Long enough that the ordinary path — insert, then enqueue milliseconds later
 * — is never second-guessed by the sweep racing it. A row that is genuinely
 * only a few seconds old is almost certainly mid-save.
 */
const STRANDED_AFTER_MS = 60_000;

/** Rows to schedule per pass. Keeps a backfill from flooding the queue at once. */
const BATCH = Number(process.env.VIDEO_SWEEP_BATCH ?? "25");

export async function processDueVideoRenders(
  supabase: SupabaseClient,
): Promise<{ scheduled: number; skipped: number }> {
  const queue = getVideoRenderQueue();
  if (!queue) return { scheduled: 0, skipped: 0 };

  const cutoff = new Date(Date.now() - STRANDED_AFTER_MS).toISOString();
  const { data: rows } = await supabase
    .from("ad_video_jobs")
    .select("id, owner_id, campaign_id, creative_id, revision, render_hash, output_profile, design, attempts")
    .eq("state", "queued")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(BATCH);

  let scheduled = 0;
  let skipped = 0;

  for (const row of rows ?? []) {
    const hash = row.render_hash as string;
    const profile = (row.output_profile as string) ?? "default";

    // Already scheduled? Existence is not the question — BullMQ retains a job
    // after it finishes, so a failed or completed job is still findable and is
    // emphatically not scheduled. Treating "a job exists" as "work is coming"
    // left rows queued forever behind the corpse of the attempt that failed
    // them, which is precisely the stranding this sweep exists to undo.
    //
    // A job in a live state is left alone. A dead one is removed so the id is
    // free, then re-added below.
    const jobId = renderJobId(hash, profile);
    const existing = await queue.getJob(jobId).catch(() => null);
    if (existing) {
      const jobState = await existing.getState().catch(() => "unknown");
      if (jobState === "failed" || jobState === "completed") {
        await existing.remove().catch(() => {});
      } else {
        skipped++;
        continue;
      }
    }

    // A row with no design cannot be rendered and re-queueing it forever would
    // be a hot loop against Redis. Fail it so it stops being swept and shows up
    // in the dashboard as something that needs attention.
    const snapshot = row.design as VideoDesignSnapshot | null;
    if (!snapshot || !snapshot.headline) {
      await supabase
        .from("ad_video_jobs")
        .update({ state: "failed", error_code: "no_design_snapshot" })
        .eq("id", row.id);
      skipped++;
      continue;
    }

    try {
      const ok = await enqueueRender({
        renderHash: hash,
        profile,
        data: {
          jobRowId: row.id as string,
          ownerId: row.owner_id as string,
          campaignId: (row.campaign_id as string | null) ?? null,
          creativeId: (row.creative_id as string | null) ?? null,
          revision: row.revision as number,
          snapshot,
          profile: profile as VideoProfileId,
          audioSlotSupported: false,
        },
      });
      if (ok) scheduled++;
      else skipped++;
    } catch (err) {
      // Leave the row `queued`. The next pass tries again — which is the entire
      // point of the row outliving the queue.
      console.warn(`[worker] video sweep could not schedule ${row.id}: ${(err as Error).message}`);
      skipped++;
    }
  }

  return { scheduled, skipped };
}
