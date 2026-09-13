import Redis from "ioredis";
import { isIP } from "node:net";
import { hashIp } from "@/lib/ipHash";

export const CRAWLER_IP_PER_MINUTE = 12;
export const CRAWLER_FAMILY_PER_HOUR = 600;
export const AD_IP_PER_MINUTE = 60;
const METRICS_TTL = 366 * 86400;

// All counters share Redis across replicas. Rejected requests never prolong
// the window. Metrics use fixed family/surface/outcome fields, never raw URLs.
export const REQUEST_LIMIT_LUA = `
local metrics = KEYS[#KEYS]
if ARGV[1] ~= '' then
  redis.call('HINCRBY', metrics, ARGV[1] .. ':requests', 1)
  redis.call('EXPIRE', metrics, ARGV[2])
end
local retry = 0
for i = 1, #KEYS - 1 do
  local limit = tonumber(ARGV[2 * i + 1])
  if tonumber(redis.call('GET', KEYS[i]) or '0') >= limit then
    retry = math.max(retry, redis.call('PTTL', KEYS[i]))
  end
end
if retry > 0 then
  if ARGV[1] ~= '' then redis.call('HINCRBY', metrics, ARGV[1] .. ':throttled', 1) end
  return retry
end
for i = 1, #KEYS - 1 do
  local count = redis.call('INCR', KEYS[i])
  if count == 1 then redis.call('PEXPIRE', KEYS[i], ARGV[2 * i + 2]) end
end
return 0
`;
let redis: Redis | undefined;
function connection(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!redis || redis.status === "end") {
    redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1000, commandTimeout: 1500, retryStrategy: () => null });
    redis.on("error", () => {});
  }
  return redis;
}

export const activityKey = (date = new Date()) => `crawl:activity:${date.toISOString().slice(0, 10)}`;

/** Railway supplies X-Real-IP. Do not let a forged CF header override it. */
export function sourceIp(headers: Headers): string | null {
  const ip = headers.get("x-real-ip")?.trim();
  return ip && isIP(ip) ? ip : null;
}

export async function limitCrawlRequest(request: Request, family: string | null, surface: "ad" | "page"): Promise<Response | undefined> {
  const ip = sourceIp(request.headers);
  const keys = [`crawl:request:ip:${hashIp(ip ?? "unknown")}`];
  const field = family ? `${family}:${surface}` : "";
  const args: Array<string | number> = [field, METRICS_TTL, family ? CRAWLER_IP_PER_MINUTE : AD_IP_PER_MINUTE, 60_000];
  if (family) {
    keys.push(`crawl:request:family:${family}`);
    args.push(CRAWLER_FAMILY_PER_HOUR, 3_600_000);
  }
  keys.push(activityKey());
  try {
    const client = connection();
    if (!client) throw new Error("unavailable");
    const retryMs = Number(await client.eval(REQUEST_LIMIT_LUA, keys.length, ...keys, ...args));
    if (!Number.isFinite(retryMs)) throw new Error("invalid_response");
    if (retryMs === 0) return;
    return refusal(429, "crawler_rate_limited", Math.max(1, Math.ceil(retryMs / 1000)));
  } catch {
    // Preserve human redirects during Redis outages; the existing click
    // admission still withholds billing unless its own check succeeds.
    if (!family) return;
    return refusal(503, "crawler_limits_unavailable", 60);
  }
}

function refusal(status: number, error: string, retry: number): Response {
  return Response.json({ error, retry_after_seconds: retry, crawl_access: "/crawl" }, {
    status, headers: { "retry-after": String(retry), "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

export async function recordCrawlerOutcome(family: string, surface: "ad" | "page", outcome: "payment_required" | "pass_issued" | "blocked" | "passed"): Promise<void> {
  try {
    const client = connection();
    if (client) await client.multi().hincrby(activityKey(), `${family}:${surface}:${outcome}`, 1).expire(activityKey(), METRICS_TTL).exec();
  } catch { /* Metrics do not determine access or successful payment. */ }
}

/** Operations-only aggregates. No IP addresses, cookies, URLs, or visitor IDs. */
export async function readCrawlerActivity(days: number) {
  const client = connection();
  if (!client) throw new Error("Crawler counters unavailable");
  const dates = Array.from({ length: Math.min(31, Math.max(1, days)) }, (_, i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const pipeline = client.pipeline();
  for (const date of dates) pipeline.hgetall(`crawl:activity:${date}`);
  const rows = await pipeline.exec();
  if (!rows || rows.some(([error]) => error)) throw new Error("Crawler counters unavailable");
  return dates.map((date, i) => ({ date, counts: Object.fromEntries(Object.entries(rows[i][1] as Record<string, string>).map(([key, count]) => [key, Number(count)])) }));
}
