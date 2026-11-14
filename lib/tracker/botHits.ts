// Server-side bot hits: requests a site's gateway refused (402) and so never
// ran the beacon. Without this a refused swarm is invisible to CrawlProof,
// and the slice of it that slipped through before the refusal started reads
// as human. The gateway batches counts per bucket and path and posts them.

export const BOT_HIT_BUCKET = /^bot:[a-z0-9_]{1,40}$/;
export const MAX_PER_ROW = 1_000_000;
export const MAX_ROWS = 200;

export type BotHit = { bucket: string; path: string; count: number };

/** Validate and normalise a posted batch. Null with a reason when it is not one. */
export function parseBotHits(body: unknown): { ok: true; site: string | null; hits: BotHit[] } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected a JSON object." };
  const b = body as { site?: unknown; hits?: unknown };
  if (!Array.isArray(b.hits) || !b.hits.length) return { ok: false, error: "hits must be a non-empty array." };
  if (b.hits.length > MAX_ROWS) return { ok: false, error: `At most ${MAX_ROWS} rows per call.` };
  const merged = new Map<string, BotHit>();
  for (const raw of b.hits) {
    const h = raw as { bucket?: unknown; path?: unknown; count?: unknown };
    const bucket = typeof h.bucket === "string" ? h.bucket : "";
    if (!BOT_HIT_BUCKET.test(bucket)) return { ok: false, error: `Bucket must match ${BOT_HIT_BUCKET}: ${String(h.bucket)}` };
    const count = Number(h.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_PER_ROW) return { ok: false, error: `count must be an integer 1-${MAX_PER_ROW}.` };
    let path = typeof h.path === "string" && h.path.startsWith("/") ? h.path.split("?")[0]!.slice(0, 512) : "/";
    if (!path) path = "/";
    const key = `${bucket}\u0000${path}`;
    const prev = merged.get(key);
    merged.set(key, { bucket, path, count: Math.min(MAX_PER_ROW, (prev?.count ?? 0) + count) });
  }
  const site = typeof b.site === "string" && b.site.trim() ? b.site.trim() : null;
  return { ok: true, site, hits: [...merged.values()] };
}
