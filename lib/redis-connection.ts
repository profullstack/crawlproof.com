// REDIS_URL -> bullmq connection options.
//
// Lifted out of ./prober-queue when the video render queue became the second
// caller. Kept as options rather than a shared ioredis instance on purpose:
// bullmq then builds its own client, which avoids a version clash between the
// ioredis we depend on and the one bullmq bundles.

import type { ConnectionOptions } from "bullmq";

export function redisConnectionOptions(): ConnectionOptions | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || "6379"),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
