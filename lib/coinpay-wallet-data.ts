/** Public receive-address metadata only. No keys or bearer tokens are stored. */
export type GlobalCoinpayWallet = { id: string; address: string; currency: string; label: string | null };
const PRIORITY = ["usdc_pol", "usdc_eth", "usdc_sol", "usdt_pol", "usdt_eth", "sol", "eth", "btc"];
export function normalizeGlobalWallets(raw: unknown): GlobalCoinpayWallet[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((r): GlobalCoinpayWallet[] => {
    if (!r || typeof r !== "object" || (r.source !== "account" && r.source !== "web_wallet") || r.business_id != null || r.is_active !== true) return [];
    const address = typeof r.wallet_address === "string" ? r.wallet_address.trim() : "";
    const currency = typeof r.cryptocurrency === "string" ? r.cryptocurrency.toLowerCase() : "";
    if (!address || address.length > 200 || !/^[a-z0-9]+(?:_[a-z0-9]+)?$/.test(currency) || typeof r.id !== "string") return [];
    const key = currency + ":" + address; // Base58 addresses are case-sensitive.
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ id: r.id.slice(0, 200), address, currency, label: typeof r.label === "string" ? r.label.slice(0, 120) : null }];
  }).sort((a, b) => {
    const rank = (c: string) => PRIORITY.indexOf(c) < 0 ? PRIORITY.length : PRIORITY.indexOf(c);
    return rank(a.currency) - rank(b.currency) || a.currency.localeCompare(b.currency) || a.id.localeCompare(b.id);
  });
}
export async function fetchGlobalCoinpayWallets(issuer: string, token: string, doFetch: typeof fetch = fetch): Promise<GlobalCoinpayWallet[]> {
  const r = await doFetch(issuer.replace(/\/+$/, "") + "/api/wallets?source=all", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(r.status === 403 ? "CoinPay wallet permission is needed. Connect CoinPay wallets again." : "CoinPay wallets are unavailable. Try again.");
  const j = await r.json();
  if (!Array.isArray(j.wallets)) throw new Error("CoinPay returned an invalid wallet list.");
  return normalizeGlobalWallets(j.wallets);
}
