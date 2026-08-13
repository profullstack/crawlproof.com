// ValueSERP client — Google organic results for alert polling.
// Docs: https://docs.valueserp.com/  (GET https://api.valueserp.com/search)

import { env } from "@/lib/env";
import type { Recency } from "./categories";
import { RESULTS_PER_CHECK } from "./limits";

export type SerpResult = {
  position: number;
  title: string;
  url: string;
  snippet: string;
  domain: string;
  date: string | null;
};

export type SerpResponse = {
  ok: boolean;
  // Number of billable ValueSERP searches this call consumed (1 per page ≤100).
  calls: number;
  results: SerpResult[];
  error?: string;
};

// Map our recency window onto ValueSERP's `time_period`.
function timePeriod(recency: Recency): string | null {
  switch (recency) {
    case "day":
      return "last_day";
    case "week":
      return "last_week";
    case "month":
      return "last_month";
    case "any":
    default:
      return null;
  }
}

type RawOrganic = {
  position?: number;
  title?: string;
  link?: string;
  snippet?: string;
  domain?: string;
  date?: string;
};

export function hasValueSerpKey(): boolean {
  return Boolean(env.valueSerpApiKey);
}

/**
 * When the account is out of credits, stop asking until this passes.
 *
 * ValueSERP answers an exhausted plan with HTTP 402, and the plan is a monthly
 * bucket — once it is empty every later call in the cycle gets the same
 * answer. Without this, a single campaign tick fires twenty-odd searches that
 * are all guaranteed to fail, each paying a network round-trip and filing its
 * own error, and the run summary reads as twenty distinct problems rather than
 * one. Nothing is billed either way (a 402 consumes no credit), so this buys
 * latency and legible errors, not money.
 *
 * Deliberately short. The reset time is not in the search response, so this
 * guesses low rather than parking a working key for hours.
 */
const OUT_OF_CREDITS_COOLDOWN_MS = 10 * 60_000;
let outOfCreditsUntil = 0;

/** Exposed so tests can reset the module-level cooldown between cases. */
export function resetSerpCreditCooldown(): void {
  outOfCreditsUntil = 0;
}

/**
 * Run one ValueSERP search. Returns billable `calls` even on an empty result
 * set so the caller can debit the budget accurately. Retries once on a
 * network/5xx error before giving up.
 */
export async function searchSerp(input: {
  query: string;
  recency: Recency;
  num?: number;
}): Promise<SerpResponse> {
  if (!env.valueSerpApiKey) {
    return { ok: false, calls: 0, results: [], error: "VALUESERP_API_KEY not set" };
  }
  if (Date.now() < outOfCreditsUntil) {
    return {
      ok: false,
      calls: 0,
      results: [],
      error: "ValueSERP is out of monthly credits (HTTP 402) — not retrying until the cooldown passes",
    };
  }
  const num = Math.min(input.num ?? RESULTS_PER_CHECK, 100);
  const params = new URLSearchParams({
    api_key: env.valueSerpApiKey,
    q: input.query,
    num: String(num),
    google_domain: "google.com",
    gl: "us",
    hl: "en",
    location: env.valueSerpLocation,
    output: "json",
  });
  const tp = timePeriod(input.recency);
  if (tp) {
    params.set("time_period", tp);
    // Surface the freshest results first when a window is applied.
    params.set("sort_by", "date");
  }
  const url = `https://api.valueserp.com/search?${params.toString()}`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = `ValueSERP HTTP ${res.status}`;
        // 402 is an empty monthly plan, which no later call in this cycle can
        // change. Park every caller rather than letting each one rediscover it.
        if (res.status === 402) {
          outOfCreditsUntil = Date.now() + OUT_OF_CREDITS_COOLDOWN_MS;
          lastErr = "ValueSERP HTTP 402 — monthly credit plan is exhausted";
        }
        // 4xx (bad query, out of quota) won't fix on retry.
        if (res.status < 500) return { ok: false, calls: 0, results: [], error: lastErr };
        continue;
      }
      const json = (await res.json()) as { organic_results?: RawOrganic[] };
      const rows = json.organic_results ?? [];
      const results: SerpResult[] = rows
        .filter((r) => typeof r.link === "string" && r.link)
        .map((r, i) => ({
          position: r.position ?? i + 1,
          title: r.title ?? "",
          url: r.link as string,
          snippet: r.snippet ?? "",
          domain: r.domain ?? "",
          date: r.date ?? null,
        }));
      return { ok: true, calls: 1, results };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, calls: 0, results: [], error: lastErr || "ValueSERP request failed" };
}
