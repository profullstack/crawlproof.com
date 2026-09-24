// The render worker: consumes ad-video-render jobs, produces validated media,
// publishes a revision atomically.

import { Worker, type Job } from "bullmq";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redisConnectionOptions } from "../lib/redis-connection";
import { VIDEO_RENDER_QUEUE, type VideoRenderJobData } from "../lib/ads/video/queue";
import { renderPreroll, RenderError } from "../lib/ads/video/render";
import { uploadRenderedAssets } from "../lib/ads/video/storage";
import { captureFrames } from "./frames";

/** Renders are CPU-bound; two at a time is what a Railway worker container takes. */
const CONCURRENCY = Number(process.env.VIDEO_RENDER_CONCURRENCY ?? "2");

async function setJobState(
  supabase: SupabaseClient,
  jobRowId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await supabase.from("ad_video_jobs").update(patch).eq("id", jobRowId);
}

/**
 * Publish a finished revision.
 *
 * The compare-and-swap is the whole point. Two edits in quick succession queue
 * revisions 4 and 5; if 4's render is slow and finishes second, a naive write
 * would set published_revision back to 4 and start serving media for a design
 * the advertiser has already replaced. Conditioning the update on
 * requested_revision still being 4 means the stale job's write matches no rows
 * and is discarded, which is the correct outcome rather than an error.
 */
async function publishRevision(
  supabase: SupabaseClient,
  args: { creativeId: string; revision: number },
): Promise<boolean> {
  const { data } = await supabase
    .from("ad_creatives")
    .update({ published_revision: args.revision })
    .eq("id", args.creativeId)
    .eq("requested_revision", args.revision)
    .select("id");
  return (data?.length ?? 0) > 0;
}

export async function processRenderJob(
  supabase: SupabaseClient,
  job: Job<VideoRenderJobData>,
): Promise<{ published: boolean; assets: number }> {
  const d = job.data;
  const workDir = await mkdtemp(path.join(tmpdir(), "ad-video-"));

  try {
    await setJobState(supabase, d.jobRowId, {
      state: "rendering",
      attempts: job.attemptsMade + 1,
    });

    const { assets, problems } = await renderPreroll({
      snapshot: d.snapshot,
      workDir,
      captureFrames,
      audioSlotSupported: d.audioSlotSupported,
    });

    await setJobState(supabase, d.jobRowId, { state: "validating" });

    if (problems.length > 0) {
      // Validation failures are not retryable: the same inputs will produce the
      // same output. Failing fast beats burning three attempts on it.
      await setJobState(supabase, d.jobRowId, {
        state: "failed",
        error_code: "validation_failed",
      });
      throw new Error(
        `validation failed: ${problems.map((p) => `${p.check} expected ${p.expected}, got ${p.actual}`).join("; ")}`,
      );
    }

    // A preview render has no creative to attach to and nothing to publish. Its
    // bytes are kept for the dashboard to play and expire on their own.
    if (!d.creativeId || !d.campaignId) {
      await setJobState(supabase, d.jobRowId, { state: "ready" });
      return { published: false, assets: assets.length };
    }

    const uploaded = await uploadRenderedAssets({
      assets,
      ownerId: d.ownerId,
      campaignId: d.campaignId,
      creativeId: d.creativeId,
      revision: d.revision,
    });

    // Rows first, unpublished. The revision becomes servable only once every
    // object is recorded, so a crash between these two steps leaves a complete
    // set of unpublished assets rather than a creative pointing at media that
    // is half uploaded.
    await supabase.from("ad_video_assets").insert(
      uploaded.map((u) => ({
        creative_id: d.creativeId,
        owner_id: d.ownerId,
        revision: d.revision,
        profile: u.profile,
        object_key: u.objectKey,
        content_type: u.contentType,
        byte_size: u.byteSize,
        sha256: u.sha256,
        width: u.width,
        height: u.height,
        duration_ms: u.durationMs === null ? null : Math.round(u.durationMs),
        codecs: u.codecs,
        published: true,
      })),
    );

    const published = await publishRevision(supabase, {
      creativeId: d.creativeId,
      revision: d.revision,
    });

    await setJobState(supabase, d.jobRowId, {
      state: "ready",
      error_code: published ? null : "superseded",
    });

    return { published, assets: uploaded.length };
  } catch (err) {
    const code = err instanceof RenderError ? err.code : "render_failed";
    await setJobState(supabase, d.jobRowId, { state: "failed", error_code: code });
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Start the consumer. No-ops when Redis is not configured, like the prober. */
export function startVideoRenderWorker(supabase: SupabaseClient): Worker | null {
  const connection = redisConnectionOptions();
  if (!connection) {
    console.log("[worker] video render: REDIS_URL not set, not starting");
    return null;
  }

  const worker = new Worker<VideoRenderJobData>(
    VIDEO_RENDER_QUEUE,
    (job) => processRenderJob(supabase, job),
    { connection, concurrency: CONCURRENCY },
  );

  worker.on("failed", (job, err) => {
    console.error(`[worker] video render ${job?.id} failed: ${err.message}`);
  });
  worker.on("completed", (job) => {
    console.log(`[worker] video render ${job.id} ready`);
  });

  return worker;
}
