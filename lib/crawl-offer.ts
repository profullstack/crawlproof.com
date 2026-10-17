/**
 * What a crawler pass is, said plainly, in every place a buyer meets it: the
 * JSON 402, the x402 `description`/`resource` metadata inside it, the HTML
 * sales page at /crawl, and /docs/crawl-access.
 *
 * Agents fetching /crawl kept asking whether the 402 was the product, a
 * paywall or a test, what the $1 actually bought, and how to pay without an
 * x402 client. The bare offer answered none of that. This module adds the
 * answer WITHOUT touching the protocol fields a client signs against: the
 * `accepts` entries keep their scheme, network, amount, asset, payTo,
 * resource and timeout; only the human-readable `description` changes, and
 * the explanation rides beside them as extra top-level keys an x402 client
 * ignores. Pure functions, no I/O: the proxy imports this.
 */

export const CRAWL_PRICE_USD = 1;
export const CRAWL_PASS_MINUTES = 1440;
export const CRAWL_MAX_DAYS = 30;
export const CRAWL_DOCS_PATH = "/docs/crawl-access";
export const POWER_KEY_SHOP = "https://profullstack.com/shop";

/** The exact body /crawl returns once paid, so a buyer knows what it gets. */
export function sampleReceipt(siteUrl: string) {
  return {
    ok: true,
    pass: "cp_<base64url payload>.<base64url signature>",
    expires_at: "2026-10-18T12:00:00.000Z",
    days: 1,
    minutes: CRAWL_PASS_MINUTES,
    header: "x-crawl-pass",
    replayed: false,
    use: `curl -H "x-crawl-pass: cp_..." ${siteUrl}/`,
  };
}

/** One sentence for the x402 `description` of an offer for `days` days. */
export function offerDescription(siteUrl: string, days = 1): string {
  const host = new URL(siteUrl).host;
  const term = days > 1 ? `${days} days (${days * CRAWL_PASS_MINUTES} minutes)` : `24 hours (${CRAWL_PASS_MINUTES} minutes)`;
  return (
    `$${(CRAWL_PRICE_USD * days).toFixed(2)} USDC buys a crawler pass for ${host}: ` +
    `this URL returns a JSON receipt with a signed pass token; send it as the x-crawl-pass header ` +
    `to read every public page on ${host} for ${term}. ` +
    `This is a paid access pass for automated crawlers, not an error, not a test and not the site audit.`
  );
}

export function aboutCrawlPass(siteUrl: string, days = 1) {
  const docs = `${siteUrl}${CRAWL_DOCS_PATH}`;
  const buy = `${siteUrl}/crawl`;
  return {
    what:
      "This 402 is CrawlProof's paywall for automated crawlers (training and commercial data collection). " +
      "It is working as intended: not an error and not a test. People, search engines and AI retrieval " +
      "crawlers that cite their sources read crawlproof.com free and never see it.",
    not_the_audit:
      `Looking for the free AEO audit of your own site? That is ${siteUrl}/ and needs no payment.`,
    price: `$${(CRAWL_PRICE_USD * days).toFixed(2)} USDC (exact scheme) on Base, Polygon or Ethereum`,
    buys:
      `One pass: a signed token that lets your crawler read every public page on ${new URL(siteUrl).host} ` +
      `for ${days > 1 ? `${days} days` : "24 hours"} from the moment you pay. Paying returns a JSON receipt ` +
      `(sample_response); send its "pass" value in the x-crawl-pass header (or Authorization: Bearer) on each request.`,
    duration_minutes: days * CRAWL_PASS_MINUTES,
    more_days: `Up to ${CRAWL_MAX_DAYS} days in one payment: ${buy}?days=<n> quotes n × $1.`,
    does_not_include:
      "Account access, the paid audit engines, or exemption from rate limits (12 requests/minute per IP, " +
      "600/hour per crawler family). Automated ad-link requests never count as clicks.",
    sample_response: sampleReceipt(siteUrl),
    docs,
    pay_with_x402: `curl -H "X-PAYMENT: <base64 proof>" ${buy}`,
    pay_without_an_x402_client: {
      browser_wallet: `npx @profullstack/coinpay x402 pay ${buy} --output pass.json`,
      browser_wallet_note:
        "Opens a browser tab to approve the $1 USDC with MetaMask, Rabby, Coinbase Wallet or the CoinPay Wallet; writes the receipt to pass.json.",
      power_key: POWER_KEY_SHOP,
      power_key_note:
        "A Power Key is a one-time crypto checkout through CoinPay (USDC, ETH, BTC, SOL) that opens crawlproof.com and every other Profullstack site with no day passes. Send it as x-power-key or Authorization: Bearer pfs_...",
      invoice: "mailto:support@crawlproof.com",
      invoice_note: "Bulk or invoiced crawl access: email us.",
    },
  };
}

type Offer = {
  x402Version?: number;
  accepts?: Array<Record<string, unknown>>;
  pass?: { days?: number };
  [key: string]: unknown;
};

/**
 * Add the explanation to a gateway 402 body. Protocol fields stay byte-for-
 * byte except each entry's `description`; x402 v2's top-level `resource`
 * object (url, description, mimeType) is filled in so v2 clients that read it
 * show the same sentence.
 */
export function explainOffer<T extends Offer>(body: T, siteUrl: string): T & { about: ReturnType<typeof aboutCrawlPass> } {
  const days = Number(body.pass?.days) > 0 ? Number(body.pass!.days) : 1;
  const description = offerDescription(siteUrl, days);
  const accepts = Array.isArray(body.accepts)
    ? body.accepts.map((a) => ({ ...a, description }))
    : body.accepts;
  const resourceUrl =
    (Array.isArray(body.accepts) && typeof body.accepts[0]?.resource === "string" && (body.accepts[0].resource as string)) ||
    `${siteUrl}/crawl`;
  const error = typeof body.error === "string" && body.error.startsWith("Payment required for training crawlers")
    ? `Payment required: crawlers need a $${(CRAWL_PRICE_USD * days).toFixed(2)} USDC pass for ${days > 1 ? `${days} days` : "24 hours"} of access. ` +
      `What it buys and how to pay (with or without x402): ${siteUrl}${CRAWL_DOCS_PATH}`
    : body.error;
  return {
    ...body,
    ...(error !== undefined ? { error } : {}),
    resource: { url: resourceUrl, description, mimeType: "application/json" },
    accepts,
    about: aboutCrawlPass(siteUrl, days),
  } as T & { about: ReturnType<typeof aboutCrawlPass> };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The same explanation as an HTML block for the top of the sales page. */
export function aboutHtml(siteUrl: string): string {
  const a = aboutCrawlPass(siteUrl);
  const p = a.pay_without_an_x402_client;
  return `<h2>What this is</h2>
<p>${esc(a.what)}</p>
<p>Looking for the free AEO audit of your own site? That is <a href="${esc(siteUrl)}/">${esc(siteUrl)}/</a> and needs no payment.</p>
<h2>What $1 buys</h2>
<p>${esc(a.buys)}</p>
<p class="mut">Not included: ${esc(a.does_not_include)}</p>
<p>Once paid, <code>/crawl</code> answers <code>200</code> with exactly this shape:</p>
<pre><code>${esc(JSON.stringify(a.sample_response, null, 2))}</code></pre>
<h2>Pay without an x402 client</h2>
<ul>
  <li><strong>Browser wallet:</strong> <code>${esc(p.browser_wallet)}</code> — ${esc(p.browser_wallet_note)}</li>
  <li><strong>Power Key:</strong> <a href="${esc(p.power_key)}">${esc(p.power_key)}</a> — ${esc(p.power_key_note)}</li>
  <li><strong>Invoice / bulk:</strong> <a href="${esc(p.invoice)}">support@crawlproof.com</a></li>
</ul>
<p>Full guide: <a href="${esc(a.docs)}">${esc(a.docs)}</a></p>
`;
}
