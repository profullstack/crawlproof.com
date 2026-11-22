// Client for the CrawlProof A/B test API (/api/abtest/v1). Every call has a short
// timeout. With failOpen (the default) a failure never throws: assign() falls back
// to the same deterministic arm the server would pick, and tracking calls resolve
// to { ok: false, error } so an outage at the stats end never breaks the product.

import { assignArm, type ArmSpec } from "./assign";
import type { Summary } from "./stats";

export type EventType = "exposure" | "conversion" | "revenue" | "event";

export type ExperimentDef = {
  key: string;
  name?: string;
  description?: string;
  arms: ArmSpec[] | Array<{ key: string; label?: string; weight?: number }>;
  /** Arm key of the control (default: the first arm). */
  control?: string;
  /** Exposed units per arm before a verdict is read (default 100). */
  min_per_arm?: number;
};

export type TrackOptions = {
  /** Event name; required for type "event" (e.g. "voice_meeting"). */
  name?: string;
  /** Revenue amount (type "revenue"), or a value for any event. */
  value?: number;
  /** Arm the caller already knows; the server's stored assignment wins when they differ. */
  arm?: string;
  /** Idempotency key: the same id is only ever counted once per experiment. */
  id?: string;
};

export type ClientOptions = {
  token?: string;
  baseUrl?: string;
  timeoutMs?: number;
  failOpen?: boolean;
  fetch?: typeof fetch;
};

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export function createClient(opts: ClientOptions = {}) {
  const base = (opts.baseUrl ?? "https://crawlproof.com").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 4000;
  const failOpen = opts.failOpen ?? true;
  const doFetch = opts.fetch ?? globalThis.fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
    if (!opts.token) return fail("no CrawlProof token configured");
    try {
      const res = await doFetch(`${base}/api/abtest/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${opts.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return fail(String(json.error ?? `HTTP ${res.status}`));
      return { ok: true, ...(json as T) };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  function fail(error: string): { ok: false; error: string } {
    if (!failOpen) throw new Error(`crawlproof abtest: ${error}`);
    return { ok: false, error };
  }

  const track = (experiment: string, unit: string, type: EventType, o: TrackOptions = {}) =>
    call<{ arm: string; duplicate?: boolean }>("POST", "/events", { experiment, unit, type, ...o });

  return {
    /** Create the experiment if it does not exist (a running experiment's arms are frozen). */
    experiment: (def: ExperimentDef) => call<{ experiment: Record<string, unknown>; created: boolean }>("POST", "/experiments", def),

    /**
     * The unit's sticky arm. `arms` is the local fallback: when the server cannot be
     * reached the same deterministic arm is computed here and `offline: true` is set.
     */
    async assign(experiment: string, unit: string, arms?: ArmSpec[]): Promise<{ arm: string | null; new?: boolean; offline?: boolean; error?: string }> {
      const r = await call<{ arm: string; new: boolean }>("POST", "/assign", { experiment, unit });
      if (r.ok) return { arm: r.arm, new: r.new };
      return { arm: arms ? assignArm(experiment, unit, arms) : null, offline: true, error: r.error };
    },

    track,
    exposure: (experiment: string, unit: string, o: TrackOptions = {}) => track(experiment, unit, "exposure", o),
    conversion: (experiment: string, unit: string, o: TrackOptions = {}) => track(experiment, unit, "conversion", o),
    revenue: (experiment: string, unit: string, amount: number, o: TrackOptions = {}) => track(experiment, unit, "revenue", { ...o, value: amount }),
    event: (experiment: string, unit: string, name: string, o: TrackOptions = {}) => track(experiment, unit, "event", { ...o, name }),

    /** The experiment with per-arm stats and the verdict. */
    stats: (experiment: string) => call<{ experiment: Record<string, unknown>; summary: Summary }>("GET", `/experiments/${encodeURIComponent(experiment)}`),
    list: () => call<{ experiments: Array<Record<string, unknown>> }>("GET", "/experiments"),
  };
}

export type AbtestClient = ReturnType<typeof createClient>;
