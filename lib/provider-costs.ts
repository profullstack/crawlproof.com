import { env } from "./env";

/**
 * Live balance/quota readout for the paid third-party services this app bills
 * against.
 *
 * Exists because a spend anomaly is invisible until someone thinks to open
 * three different vendor dashboards. Every provider below exposes its balance
 * to the *same* API key the app already deploys, so no admin credential or
 * billing API is needed — which is what makes surfacing this practical at all.
 * OpenAI and Anthropic are deliberately absent: their cost APIs return 403/401
 * to ordinary project keys and require a separately minted admin key.
 *
 * Server-only. Never import this into a client component — it reads secrets.
 */

export type CostStatus = "ok" | "low" | "critical" | "error" | "unconfigured";

export interface ProviderCost {
  provider: string;
  /** Headline figure, pre-formatted for display. */
  display: string;
  /** Fractional consumption where the provider reports a limit, else null. */
  usedFraction: number | null;
  status: CostStatus;
  detail?: string;
}

const TIMEOUT_MS = 8000;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Prepaid USD balance. Thresholds are absolute because there is no limit or
 * reset date to compute a percentage against.
 */
function balanceStatus(usd: number): CostStatus {
  if (usd <= 1) return "critical";
  if (usd <= 5) return "low";
  return "ok";
}

async function deepseek(): Promise<ProviderCost> {
  if (!env.deepseekApiKey) {
    return { provider: "DeepSeek", display: "—", usedFraction: null, status: "unconfigured" };
  }
  try {
    const body = (await fetchJson("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${env.deepseekApiKey}` },
    })) as { balance_infos?: Array<{ currency?: string; total_balance?: string }> };

    const info = body.balance_infos?.[0] ?? {};
    const usd = Number.parseFloat(info.total_balance ?? "0") || 0;
    return {
      provider: "DeepSeek",
      display: `$${usd.toFixed(2)} ${info.currency ?? "USD"}`,
      usedFraction: null,
      status: balanceStatus(usd),
    };
  } catch (err) {
    return { provider: "DeepSeek", display: "—", usedFraction: null, status: "error", detail: String(err) };
  }
}

async function moonshot(): Promise<ProviderCost> {
  if (!env.moonshotApiKey) {
    return { provider: "Moonshot / Kimi", display: "—", usedFraction: null, status: "unconfigured" };
  }
  try {
    // Host matters: Moonshot keys are region-bound and a .cn key 401s here in
    // a way that looks identical to a revoked credential.
    const body = (await fetchJson("https://api.moonshot.ai/v1/users/me/balance", {
      headers: { Authorization: `Bearer ${env.moonshotApiKey}` },
    })) as { data?: { available_balance?: number } };

    const usd = Number(body.data?.available_balance ?? 0);
    return {
      provider: "Moonshot / Kimi",
      display: `$${usd.toFixed(2)} USD`,
      usedFraction: null,
      status: balanceStatus(usd),
    };
  } catch (err) {
    return {
      provider: "Moonshot / Kimi",
      display: "—",
      usedFraction: null,
      status: "error",
      detail: `${err} — if 401, check the key's region (.ai vs .cn)`,
    };
  }
}

async function valueSerp(): Promise<ProviderCost> {
  if (!env.valueSerpApiKey) {
    return { provider: "ValueSERP", display: "—", usedFraction: null, status: "unconfigured" };
  }
  try {
    const body = (await fetchJson(
      `https://api.valueserp.com/account?api_key=${encodeURIComponent(env.valueSerpApiKey)}`,
    )) as {
      account_info?: {
        monthly_credits_limit?: number;
        monthly_credits_remaining?: number;
        monthly_credits_reset_at?: string;
      };
    };

    const info = body.account_info ?? {};
    const limit = Number(info.monthly_credits_limit ?? 0);
    const remaining = Number(info.monthly_credits_remaining ?? 0);
    const usedFraction = limit > 0 ? (limit - remaining) / limit : null;

    // A metered quota is judged on headroom, not an absolute figure.
    let status: CostStatus = "ok";
    if (usedFraction !== null && usedFraction >= 0.9) status = "critical";
    else if (usedFraction !== null && usedFraction >= 0.75) status = "low";

    const resets = info.monthly_credits_reset_at
      ? new Date(info.monthly_credits_reset_at).toISOString().slice(0, 10)
      : null;

    return {
      provider: "ValueSERP",
      display: `${remaining.toLocaleString()} / ${limit.toLocaleString()} credits`,
      usedFraction,
      status,
      detail: resets ? `resets ${resets}` : undefined,
    };
  } catch (err) {
    return { provider: "ValueSERP", display: "—", usedFraction: null, status: "error", detail: String(err) };
  }
}

/**
 * Fetch every provider concurrently. One vendor being down must never blank
 * the whole panel, so each connector resolves to an `error` row instead of
 * throwing.
 */
export async function getProviderCosts(): Promise<ProviderCost[]> {
  return Promise.all([deepseek(), moonshot(), valueSerp()]);
}
