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
import { probeMedia } from "../lib/ads/video/validate";
import { synthesiseNarration } from "../lib/ads/video/narration";
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
    .update({
      published_revision: args.revision,
      // Promoted out of "generating" in the same write.
      //
      // The row is created as "generating" so nothing serves a creative that
      // has no bytes yet, and publishing the revision IS the moment it gains
      // them — but the status was never moved, so all 185 video creatives sat
      // at "generating" with validated media behind them. Selection only
      // considers "ready", so every streaming break fell through to the house
      // ad: the whole pipeline worked and nothing could ever be served.
      //
      // Same write as published_revision deliberately. Two statements could
      // leave a creative servable-by-status with no published revision, or the
      // reverse, and the compare-and-swap below protects both together.
      status: "ready",
    })
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

    // Narration, best effort. A silent pre-roll is a working ad; a render that
    // fails because a speech API was rate-limited is not — so this returns null
    // on every failure and the silent cut ships.
    const narration = await synthesiseNarration({ snapshot: d.snapshot, workDir });
    if (narration) {
      console.log(`[render] narration: ${narration.byteSize} bytes — "${narration.script}"`);
    } else {
      console.log("[render] narration: none (no key or synthesis failed), rendering silent");
    }

    const { assets, problems } = await renderPreroll({
      audioPath: narration?.filePath ?? null,
      // GIF frame counts come from a decode, not the header, for the same
      // reason the video's do: a truncated write still parses.
      probeGif: async (file: string) => {
        const probe = await probeMedia(file);
        const v = probe.streams.find((st) => st.codec_type === "video");
        return {
          width: Number(v?.width ?? 0),
          height: Number(v?.height ?? 0),
          frames: Number(v?.nb_read_frames ?? 0),
        };
      },
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
    // Upsert, not insert, and the error is checked.
    //
    // There is a unique index on (creative_id, revision, profile), so a
    // re-render of the same revision — exactly what a RENDERER_VERSION bump
    // asks for — violated it. The result was not an error anybody saw: the
    // return value was discarded, so the insert failed, the job was marked
    // ready, and the revision kept the assets of the render it was supposed to
    // replace. Every fix since the version bump landed in storage and was then
    // dropped here in silence.
    //
    // Replacing the row is right for the same reason replacing the object is:
    // the design did not change, the renderer did.
    const { error: assetError } = await supabase.from("ad_video_assets").upsert(
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
      { onConflict: "creative_id,revision,profile" },
    );
    if (assetError) {
      // Loudly. A revision whose rows were not written is a revision that
      // points at nothing, and marking it ready would repeat the failure this
      // very change exists to end.
      await setJobState(supabase, d.jobRowId, {
        state: "failed",
        error_code: "asset_rows_failed",
      });
      throw new Error(`asset rows failed: ${assetError.message}`);
    }

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
