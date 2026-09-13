import { createGateway, readPass, renderPage, type Sale } from "@profullstack/x402-gateway";
import { x402Proxy } from "@profullstack/x402-gateway/next";
import { crawlerFamily, isAdClickPath, isPaidCrawler, PAID_CRAWLERS } from "./crawl-policy";
import { limitCrawlRequest, recordCrawlerOutcome, CRAWLER_IP_PER_MINUTE, CRAWLER_FAMILY_PER_HOUR } from "./crawl-limits";

/**
 * Sells day passes to commercial and training crawlers using x402-gateway.
 * Next 16's Node proxy enforces shared limits before payment or app queries.
 * The env is read through a non-literal key on purpose: Next inlines
 * `process.env.NAME` at build time, and these are runtime secrets. Without
 * COINPAY_X402_KEY and CRAWL_PAY_TO the gateway still answers training
 * crawlers with 402, just with an empty offer.
 */
const env = (name: string) => process.env[name];

const siteUrl = env("SITE_URL") || env("NEXT_PUBLIC_SITE_URL") || "https://crawlproof.com";

/**
 * A crawler just bought a day pass, so a share of what it paid becomes the
 * pool that readers and agents are paid from. See lib/earn/rates.ts for the
 * share and supabase/migrations/20260906120000_earn_rail.sql for why the pool
 * is the only thing rewards may be drawn from.
 *
 * Posted to our own route rather than written from here, because this module
 * is imported by the middleware and the earn library reaches Node-only code.
 * `ref` is the payment's own reference and the endpoint is idempotent on it.
 *
 * The promise is RETURNED, not fired and forgotten: the gateway awaits this
 * before it hands the buyer its receipt, and on an edge runtime a
 * fire-and-forget write can be cut off the moment the response is sent —
 * losing the sale while the buyer keeps the pass. The gateway swallows a
 * rejection either way, so a failure here never costs anybody their pass.
 */
function recordSale(sale: Sale): void | Promise<void> {
  const secret = env("WORKER_SHARED_SECRET");
  if (!secret || !sale?.ref || !sale?.priceCents) return;
  return fetch(`${siteUrl}/api/earn/v1/fund`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": secret },
    body: JSON.stringify({
      amount_cents: sale.priceCents,
      ref: sale.ref,
      reason: `crawler day pass${sale.userAgent ? `: ${String(sale.userAgent).slice(0, 120)}` : ""}`,
    }),
  }).then(() => undefined);
}

export const gateway = createGateway({
  siteUrl,
  siteName: "CrawlProof",
  coinpay: { apiKey: env("COINPAY_X402_KEY") },
  payTo: env("CRAWL_PAY_TO"),
  contact: "mailto:support@crawlproof.com",
  onSale: recordSale,
  training: PAID_CRAWLERS,
  isPaidAgent: isPaidCrawler,
  page: (ctx) => renderPage(ctx)
    .replace("Training crawlers pay for access here.", "Commercial and training crawlers pay for access here.")
    .replace("A crawler that copies pages into a training corpus sends nobody back, so it pays for the time it spends.", "Commercial data collection and training access require a paid pass.")
    .replace("<h2>How it works</h2>", `<p>All crawlers, including paid crawlers, are limited to ${CRAWLER_IP_PER_MINUTE} requests per minute per IP and ${CRAWLER_FAMILY_PER_HOUR} requests per hour per crawler family. Honour Retry-After. A pass grants access to public resources; it does not grant account access. Automated ad-link requests never count as ad clicks or earn publisher payouts.</p><h2>How it works</h2>`),
});

const paidGate = x402Proxy(gateway);

async function hasPass(request: Request): Promise<boolean> {
  const token = request.headers.get(gateway.options.header)?.trim()
    || /^Bearer\s+(cp_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const secret = gateway.options.secret || gateway.options.coinpay.apiKey;
  return Boolean(secret && token && await readPass(token, { secret }));
}

/** A commercial crawler pays; its signed pass does not waive rate limits. */
export async function gate(request: Request): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  const ad = isAdClickPath(path);
  const family = crawlerFamily(request.headers.get("user-agent"));
  // Service APIs are independently authenticated. Don't throttle an entire
  // publisher's feed-serving integration as if it were a public page crawl.
  const throttle = ad || path === "/crawl" || (family && !path.startsWith("/api/"));
  if (throttle) {
    const refused = await limitCrawlRequest(request, family, ad ? "ad" : "page");
    if (refused) return refused;
  }
  const answer = await paidGate(request);
  if (answer) {
    if (family && throttle) await recordCrawlerOutcome(family, ad ? "ad" : "page", answer.status === 200 ? "pass_issued" : "payment_required");
    return answer;
  }
  // Search crawlers may read content free, but ad redirects require a pass.
  // This happens before impression/campaign lookups and before click writes.
  if (ad && family && !(await hasPass(request))) {
    await recordCrawlerOutcome(family, "ad", "blocked");
    return Response.json({ error: "ad_redirect_crawl_disallowed", crawl_access: "/crawl" }, {
      status: 403, headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
    });
  }
  if (family && throttle) await recordCrawlerOutcome(family, ad ? "ad" : "page", "passed");
}
