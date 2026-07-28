// What the AI costs, computed at the point of spending it.
//
// The provider will not tell the app: Anthropic's cost and usage reports need
// an Admin key, and a normal API key gets a 401 on them. What every response
// does carry is its token counts, and the per-model rates are published — so
// the cost is calculable here, and here is also the only place that knows
// which feature caused it.
//
// Everything below is in micro-dollars ($1 = 1_000_000). Model rates are per
// million tokens, so one Haiku draft costs a fraction of a cent; in cents, a
// day of real spending rounds to zero.

import { serviceClient } from "@/lib/supabase/service";

const MICROS_PER_DOLLAR = 1_000_000;

/** Published rates, in micro-dollars per million tokens. */
type Rate = { input: number; output: number };

const RATES: Record<string, Rate> = {
  // Anthropic
  "claude-haiku-4-5": { input: 1_000_000, output: 5_000_000 },
  "claude-sonnet-5": { input: 3_000_000, output: 15_000_000 },
  "claude-sonnet-4-6": { input: 3_000_000, output: 15_000_000 },
  "claude-opus-5": { input: 5_000_000, output: 25_000_000 },
  "claude-opus-4-8": { input: 5_000_000, output: 25_000_000 },
  // OpenAI
  "gpt-5-mini": { input: 250_000, output: 2_000_000 },
  "gpt-5": { input: 1_250_000, output: 10_000_000 },
};

/**
 * Rate for a model id, tolerating the dated suffixes the APIs return.
 *
 * A response reports `claude-haiku-4-5-20251001` where the request asked for
 * `claude-haiku-4-5`. Matching on the longest known prefix keeps a dated id
 * priced instead of silently costing zero.
 */
export function rateFor(model: string): Rate | null {
  const id = model.trim().toLowerCase();
  if (RATES[id]) return RATES[id];
  let best: string | null = null;
  for (const known of Object.keys(RATES)) {
    if (id.startsWith(known) && (!best || known.length > best.length)) best = known;
  }
  return best ? RATES[best] : null;
}

export type UsageSample = {
  provider: string;
  model: string;
  feature?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/** Cost of one call, in micro-dollars. Unknown models cost 0 and say so. */
export function costMicros(sample: UsageSample): { micros: number; rate: Rate | null } {
  const rate = rateFor(sample.model);
  if (!rate) return { micros: 0, rate: null };
  // Cache reads bill at roughly a tenth of input; cache writes at 1.25x. Both
  // are approximations of the published multipliers, and both are far closer
  // than ignoring them, which is what counting only fresh input would do.
  const inputEquivalent =
    sample.inputTokens +
    (sample.cacheReadTokens ?? 0) * 0.1 +
    (sample.cacheWriteTokens ?? 0) * 1.25;
  const micros =
    (inputEquivalent * rate.input) / 1_000_000 + (sample.outputTokens * rate.output) / 1_000_000;
  return { micros: Math.round(micros), rate };
}

/**
 * Record one call.
 *
 * Never throws. This runs after a request the caller already considers
 * successful, and failing to write a bookkeeping row is not a reason to fail
 * the work that was actually asked for.
 */
export async function recordAiSpend(sample: UsageSample): Promise<void> {
  try {
    const { micros, rate } = costMicros(sample);
    await serviceClient().from("ai_usage").insert({
      provider: sample.provider,
      model: sample.model,
      feature: sample.feature ?? null,
      input_tokens: sample.inputTokens,
      output_tokens: sample.outputTokens,
      cache_read_tokens: sample.cacheReadTokens ?? 0,
      cache_write_tokens: sample.cacheWriteTokens ?? 0,
      cost_micros: micros,
      rate_input_micros_per_mtok: rate?.input ?? null,
      rate_output_micros_per_mtok: rate?.output ?? null,
    });
  } catch {
    // Bookkeeping is best-effort by design.
  }
}

export type DaySpend = {
  day: string;
  totalMicros: number;
  byFeature: { feature: string; micros: number; calls: number }[];
  calls: number;
};

/** Spend since UTC midnight, with the breakdown that makes it actionable. */
export async function spendToday(): Promise<DaySpend> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);

  const { data } = await serviceClient()
    .from("ai_usage")
    .select("feature, cost_micros")
    .gte("occurred_at", start.toISOString());

  const rows = (data as { feature: string | null; cost_micros: number }[] | null) ?? [];
  const byFeature = new Map<string, { micros: number; calls: number }>();
  let totalMicros = 0;
  for (const r of rows) {
    totalMicros += r.cost_micros;
    const key = r.feature ?? "(unattributed)";
    const cur = byFeature.get(key) ?? { micros: 0, calls: 0 };
    cur.micros += r.cost_micros;
    cur.calls += 1;
    byFeature.set(key, cur);
  }

  return {
    day: start.toISOString().slice(0, 10),
    totalMicros,
    calls: rows.length,
    byFeature: [...byFeature.entries()]
      .map(([feature, v]) => ({ feature, ...v }))
      .sort((a, b) => b.micros - a.micros),
  };
}

export function formatUsd(micros: number): string {
  return `$${(micros / MICROS_PER_DOLLAR).toFixed(2)}`;
}

export { MICROS_PER_DOLLAR };
