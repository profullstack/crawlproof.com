import { env } from "./env";

// CoinPay returns wallets the merchant has configured for the business.
// Upstream endpoint: GET {COINPAY_API_URL}/api/supported-coins
// Auth: Bearer <api key>. With an API key, business is implicit.
//
// Symbol casing on the response is upper-case (BTC, USDC_POL, …) but the
// /payments/create endpoint expects lowercase (btc, usdc_pol, …). We
// normalize to lowercase in `code` and keep the upstream `symbol` for
// display.

export type CoinPayToken = {
  code: string; // lowercase, what /payments/create wants ("usdc_pol")
  symbol: string; // display ticker ("USDC")
  name: string; // human-readable ("USD Coin (Polygon)")
  chain?: string; // ("Polygon", "Solana", "Ethereum")
};

type SupportedCoinsResponse = {
  success?: boolean;
  coins?: Array<{ symbol: string; name: string; is_active: boolean; has_wallet?: boolean }>;
};

// Light per-process cache so we don't hammer CoinPay on every page render.
let cache: { ts: number; tokens: CoinPayToken[] } | null = null;
const TTL_MS = 5 * 60 * 1000;

function parseChain(symbol: string, name: string): { ticker: string; chain?: string } {
  // "USDC_POL" -> { ticker: "USDC", chain: "Polygon" }
  const m = symbol.match(/^([A-Z]+)_([A-Z]+)$/);
  if (m) {
    const chainMap: Record<string, string> = {
      ETH: "Ethereum",
      POL: "Polygon",
      SOL: "Solana",
      BSC: "BNB Chain",
    };
    return { ticker: m[1], chain: chainMap[m[2]] ?? m[2] };
  }
  // Single-chain assets: extract chain from the name parens if present
  const paren = name.match(/\(([^)]+)\)/);
  return { ticker: symbol, chain: paren?.[1] };
}

export async function fetchSupportedTokens(opts?: {
  force?: boolean;
}): Promise<CoinPayToken[]> {
  if (!opts?.force && cache && Date.now() - cache.ts < TTL_MS) {
    return cache.tokens;
  }
  if (!env.coinpayApiKey || !env.coinpayApiUrl) {
    return [];
  }
  const base = env.coinpayApiUrl.replace(/\/$/, "");
  // env.coinpayApiUrl is the bare host (e.g. https://coinpayportal.com);
  // the existing createCheckout() appends `/api/...` and we match that.
  const url = `${base}/api/supported-coins?active_only=true`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${env.coinpayApiKey}` },
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn("[coinpay-tokens] fetch failed", res.status, await res.text().catch(() => ""));
      return cache?.tokens ?? [];
    }
    const json = (await res.json()) as SupportedCoinsResponse;
    const raw = json.coins ?? [];
    const tokens: CoinPayToken[] = raw
      .filter((c) => c.is_active)
      .map((c) => {
        const { ticker, chain } = parseChain(c.symbol, c.name);
        return {
          code: c.symbol.toLowerCase(),
          symbol: ticker,
          name: c.name,
          chain,
        };
      });
    cache = { ts: Date.now(), tokens };
    return tokens;
  } catch (err) {
    console.warn("[coinpay-tokens] fetch error", err);
    return cache?.tokens ?? [];
  }
}
