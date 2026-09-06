import { createGateway, type Sale } from "@profullstack/x402-gateway";
import { x402Proxy } from "@profullstack/x402-gateway/next";

/**
 * Sells crawl access to AI training crawlers (GPTBot, ClaudeBot, CCBot,
 * meta-externalagent, Bytespider, Applebot-Extended, ...) by the day over
 * x402, settled by CoinPay in USDC. People, Googlebot and the retrieval
 * crawlers behind AI search pass through untouched.
 *
 * Runs inside the middleware, so nothing here may import Node-only modules.
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
});

/** Resolves to a Response for a refused crawler, or undefined to carry on. */
export const gate = x402Proxy(gateway);
