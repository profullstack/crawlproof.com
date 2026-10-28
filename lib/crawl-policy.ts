import { HEADLESS_AGENTS, TRAINING_AGENTS, isTrainingAgent } from "@profullstack/x402-gateway";
import { parseDevice } from "@/lib/tracker/device";

export const COMMERCIAL_CRAWLERS = ["SemrushBot", "SiteAuditBot", "AhrefsBot", "AhrefsSiteAudit", "MJ12bot", "DotBot", "BLEXBot", "DataForSeoBot"];
// Headless browsers that say so (Lightpanda, HeadlessChrome, PhantomJS) are not
// on this list since gateway 0.16: the gateway's own `headless` list gives them
// 20 pages an hour per address and charges after, so an agent fetching one page
// reads it (2026-10-28: a one-shot headless fetch of / got 402) and a headless
// crawl still pays.
export const PAID_CRAWLERS = [...TRAINING_AGENTS, ...COMMERCIAL_CRAWLERS];
const FAMILIES = [...PAID_CRAWLERS, ...HEADLESS_AGENTS, "Amazonbot", "Googlebot", "Bingbot", "Applebot", "OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User"];

/** Labels bound counter cardinality. A user agent identifies policy, not ownership. */
export function crawlerFamily(ua: string | null): string | null {
  const text = (ua ?? "").slice(0, 1024).toLowerCase();
  const named = FAMILIES.find((name) => text.includes(name.toLowerCase()));
  if (named) return named.toLowerCase();
  return parseDevice(text).deviceType === "bot" ? "other" : null;
}

export const isPaidCrawler = (ua: string) => isTrainingAgent(ua, PAID_CRAWLERS);
export const isAdClickPath = (path: string) => path.startsWith("/a/") || path === "/api/ads/click";
/** Email tracking endpoints: /t/<id>/(o.png|c|u) and /api/v1/tracking/<id>/events. */
export const isEmailTrackingPath = (path: string) =>
  path.startsWith("/t/") || path.startsWith("/api/v1/tracking/");
