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
