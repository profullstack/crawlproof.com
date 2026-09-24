// The render queue.
//
// Enqueue is driven from ad_video_jobs rows the same way port scans are driven
// from port_scans (see ../../prober-queue): the row is the durable record and
// the BullMQ job is the transient work item, so losing Redis loses throughput
// rather than losing an advertiser's render.

import { Queue } from "bullmq";
import { redisConnectionOptions } from "@/lib/redis-connection";
import type { VideoProfileId } from "./profiles";
import type { VideoDesignSnapshot } from "./snapshot";

export const VIDEO_RENDER_QUEUE = "ad-video-render";

export type VideoRenderJobData = {
  jobRowId: string;
  ownerId: string;
  campaignId: string | null;
  creativeId: string | null;
  revision: number;
  snapshot: VideoDesignSnapshot;
  profile: VideoProfileId | "default";
  audioSlotSupported: boolean;
};

let queue: Queue<VideoRenderJobData> | null = null;

export function getVideoRenderQueue(): Queue<VideoRenderJobData> | null {
  const connection = redisConnectionOptions();
  if (!connection) return null;
  if (!queue) queue = new Queue<VideoRenderJobData>(VIDEO_RENDER_QUEUE, { connection });
  return queue;
}

/**
 * BullMQ job id for a render.
 *
 * Two constraints, both learned the hard way and neither obvious from the API:
 *
 *   * No colons. BullMQ parses a custom jobId containing ":" as a structured
 *     key and rejects anything that does not split into exactly three parts.
 *     A render hash never contains one, but a caller passing a composed
 *     "owner:campaign:rev" id would work by accident and then break the moment
 *     a fourth component was added.
 *
 *   * Derived only from immutable input. The id is the dedupe key, so if it
 *     were derived from anything the job itself changes — the job row's state,
 *     an attempt counter, the creative's published revision — then a retry
 *     would compute a different id and the "already queued" check would stop
 *     working, or worse, the id would collide with a finished job and the retry
 *     would be silently dropped as a duplicate. The render hash is a hash of
 *     inputs that by construction do not change.
 */
export function renderJobId(renderHash: string, profile: string): string {
  const id = `vr-${renderHash}-${profile}`;
  if (id.includes(":")) {
    throw new Error(`render job id must not contain ':' (got ${id})`);
  }
  return id;
}

/**
 * Enqueue a render, or no-op if one is already queued for these exact inputs.
 *
 * Returns false when Redis is not configured — the caller leaves the job row
 * `queued` and a later sweep picks it up, rather than failing an advertiser's
 * campaign save because a worker dependency is down.
 */
export async function enqueueRender(args: {
  renderHash: string;
  profile: string;
  data: VideoRenderJobData;
}): Promise<boolean> {
  const q = getVideoRenderQueue();
  if (!q) return false;

  await q.add("render", args.data, {
    jobId: renderJobId(args.renderHash, args.profile),
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86_400 },
  });
  return true;
}
