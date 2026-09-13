import Redis from "ioredis";
import { hashIp } from "@/lib/ipHash";

export const CLICK_COOLDOWN_MS = 5_000;

// One atomic operation across every app instance, campaign and publisher.
// Both identity buckets must be clear; changing a visitor cookie cannot reset
// an IP's cooldown. Rejected attempts do not keep extending the window.
export const CLAIM_CLICK_LUA = `
for _, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 then return 0 end
end
for _, key in ipairs(KEYS) do
  redis.call('SET', key, '1', 'PX', ARGV[1])
end
return 1
`;

let redis: Redis | undefined;
let lastWarning = 0;
function unavailable(): ClickCooldown {
  if (Date.now() - lastWarning >= 60_000) {
    lastWarning = Date.now();
    console.warn("[ads] Click cooldown unavailable; cash and paper charges withheld.");
  }
  return { allowed: false, reason: "cooldown_unavailable" };
}
function client(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!redis || redis.status === "end") {
    redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
      commandTimeout: 1_500,
      retryStrategy: () => null,
    });
    // Errors are handled by claimClickCooldown. Never log connection URLs.
    redis.on("error", () => {});
  }
  return redis;
}

export type ClickCooldown = { allowed: boolean; reason?: "click_cooldown" | "missing_identity" | "cooldown_unavailable" };

export async function claimClickCooldown(input: {
  visitorId?: string | null;
  ip?: string | null;
}): Promise<ClickCooldown> {
  const visitor = input.visitorId?.trim();
  const keys = [
    ...(input.ip ? [`ad:click:ip:${hashIp(input.ip)}`] : []),
    ...(visitor && /^[\w-]{1,128}$/.test(visitor)
      ? [`ad:click:visitor:${hashIp(`ad-visitor:${visitor}`)}`] : []),
  ];
  if (!keys.length) return { allowed: false, reason: "missing_identity" };
  try {
    const connection = client();
    if (!connection) return unavailable();
    const accepted = await connection.eval(CLAIM_CLICK_LUA, keys.length, ...keys, CLICK_COOLDOWN_MS);
    return accepted === 1 ? { allowed: true } : { allowed: false, reason: "click_cooldown" };
  } catch {
    // Redirects still work during an outage; cash, publisher accrual and paper
    // charges require a positively confirmed admission.
    return unavailable();
  }
}
