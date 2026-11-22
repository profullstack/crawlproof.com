// Server side of the A/B test API: experiments, sticky assignments, events and
// per-arm stats. Every function takes the owner's user id and only touches that
// owner's experiments. Assignment and statistics come from @profullstack/abtest
// (packages/abtest), the same code a client uses for its offline fallback.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assignArm, normalizeArms, summarize, type ArmCounts, type Summary } from "@/packages/abtest/src";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = SupabaseClient<any>;

export const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
export const EVENT_TYPES = ["exposure", "conversion", "revenue", "event"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
const NAME_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
export const MAX_BATCH = 100;

export type Arm = { key: string; label: string; weight: number };
export type Experiment = {
  id: string;
  owner_id: string;
  key: string;
  name: string;
  description: string | null;
  arms: Arm[];
  control: string;
  min_per_arm: number;
  status: "running" | "paused" | "stopped";
  winner: string | null;
  created_at: string;
  stopped_at: string | null;
};

export class AbError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const COLS = "id, owner_id, key, name, description, arms, control, min_per_arm, status, winner, created_at, stopped_at";

/** Validate a create body. Throws AbError(400). */
export function parseExperimentDef(body: unknown): Omit<Experiment, "id" | "owner_id" | "status" | "winner" | "created_at" | "stopped_at"> {
  const b = (body ?? {}) as Record<string, unknown>;
  const key = String(b.key ?? "").trim();
  if (!KEY_RE.test(key)) throw new AbError(400, "key must be 1-80 chars of a-z, 0-9, '.', '_' or '-', starting with a letter or digit");
  if (!Array.isArray(b.arms)) throw new AbError(400, "arms must be an array of arm keys or {key, label?, weight?}");
  if (b.arms.length > 10) throw new AbError(400, "at most 10 arms (two settle fastest)");
  let arms: Arm[];
  try {
    const norm = normalizeArms(b.arms as Array<string | { key: string; weight?: number }>);
    arms = norm.map((a, i) => {
      const raw = (b.arms as unknown[])[i];
      const label = typeof raw === "object" && raw && typeof (raw as { label?: unknown }).label === "string" ? String((raw as { label: string }).label).slice(0, 120) : a.key;
      if (!NAME_RE.test(a.key)) throw new Error(`arm key ${a.key} must be a-z, 0-9, '.', '_', ':' or '-'`);
      return { key: a.key, label, weight: a.weight };
    });
  } catch (e) {
    throw new AbError(400, e instanceof Error ? e.message : String(e));
  }
  const control = b.control === undefined ? arms[0].key : String(b.control);
  if (!arms.some((a) => a.key === control)) throw new AbError(400, `control ${control} is not one of the arms`);
  const minPer = b.min_per_arm === undefined ? 100 : Number(b.min_per_arm);
  if (!Number.isInteger(minPer) || minPer < 1 || minPer > 1_000_000) throw new AbError(400, "min_per_arm must be an integer from 1 to 1,000,000");
  return {
    key,
    name: String(b.name ?? key).slice(0, 200),
    description: b.description === undefined || b.description === null ? null : String(b.description).slice(0, 2000),
    arms,
    control,
    min_per_arm: minPer,
  };
}

export async function listExperiments(sb: SB, ownerId: string): Promise<Experiment[]> {
  const { data, error } = await sb.from("ab_experiments").select(COLS).eq("owner_id", ownerId).order("created_at", { ascending: false });
  if (error) throw new AbError(500, error.message);
  return (data ?? []) as Experiment[];
}

export async function getExperiment(sb: SB, ownerId: string, key: string): Promise<Experiment | null> {
  const { data, error } = await sb.from("ab_experiments").select(COLS).eq("owner_id", ownerId).eq("key", key).maybeSingle();
  if (error) throw new AbError(500, error.message);
  return (data as Experiment | null) ?? null;
}

async function requireExperiment(sb: SB, ownerId: string, key: unknown): Promise<Experiment> {
  const k = String(key ?? "");
  if (!KEY_RE.test(k)) throw new AbError(400, "experiment must be an experiment key");
  const exp = await getExperiment(sb, ownerId, k);
  if (!exp) throw new AbError(404, `no experiment ${k}; create it with POST /api/abtest/v1/experiments`);
  return exp;
}

/** Create the experiment if it does not exist. An existing one is returned unchanged (arms are frozen once created). */
export async function upsertExperiment(sb: SB, ownerId: string, body: unknown): Promise<{ experiment: Experiment; created: boolean }> {
  const def = parseExperimentDef(body);
  const existing = await getExperiment(sb, ownerId, def.key);
  if (existing) return { experiment: existing, created: false };
  const { data, error } = await sb.from("ab_experiments").insert({ owner_id: ownerId, ...def }).select(COLS).single();
  if (error) {
    // A concurrent create won the unique (owner_id, key) race.
    const again = await getExperiment(sb, ownerId, def.key);
    if (again) return { experiment: again, created: false };
    throw new AbError(500, error.message);
  }
  return { experiment: data as Experiment, created: true };
}

/** pause, resume, or stop (optionally naming the winner). Stopped is terminal. */
export async function updateExperiment(sb: SB, ownerId: string, key: string, body: unknown): Promise<Experiment> {
  const exp = await requireExperiment(sb, ownerId, key);
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = String(b.name).slice(0, 200);
  if (b.description !== undefined) patch.description = b.description === null ? null : String(b.description).slice(0, 2000);
  if (b.status !== undefined) {
    const s = String(b.status);
    if (!["running", "paused", "stopped"].includes(s)) throw new AbError(400, "status must be running, paused or stopped");
    if (exp.status === "stopped" && s !== "stopped") throw new AbError(409, "a stopped experiment cannot be restarted; create a new key");
    patch.status = s;
    if (s === "stopped" && exp.status !== "stopped") patch.stopped_at = new Date().toISOString();
  }
  if (b.winner !== undefined) {
    if (b.winner !== null && !exp.arms.some((a) => a.key === b.winner)) throw new AbError(400, `winner ${String(b.winner)} is not one of the arms`);
    patch.winner = b.winner;
  }
  if (Object.keys(patch).length === 0) return exp;
  const { data, error } = await sb.from("ab_experiments").update(patch).eq("id", exp.id).select(COLS).single();
  if (error) throw new AbError(500, error.message);
  return data as Experiment;
}

export const unitHash = (experimentId: string, unit: string) => createHash("sha256").update(`${experimentId}:${unit}`).digest("hex");

function parseUnit(unit: unknown): string {
  const u = typeof unit === "number" ? String(unit) : typeof unit === "string" ? unit : "";
  if (!u || u.length > 200) throw new AbError(400, "unit must be a non-empty id (an account or visitor id, max 200 chars)");
  return u;
}

/**
 * The unit's arm. Running: the stored arm, or a new deterministic one (stored).
 * Paused: the stored arm, else the control, nothing stored. Stopped: the winner
 * (or the control) for everyone, nothing stored.
 */
export async function assignUnit(sb: SB, exp: Experiment, unitIn: unknown, hint?: { arm?: unknown; offline?: boolean }): Promise<{ arm: string; new: boolean; status: Experiment["status"] }> {
  const unit = parseUnit(unitIn);
  if (exp.status === "stopped") return { arm: exp.winner ?? exp.control, new: false, status: exp.status };
  const uh = unitHash(exp.id, unit);
  const { data: row, error } = await sb.from("ab_assignments").select("arm").eq("experiment_id", exp.id).eq("unit_hash", uh).maybeSingle();
  if (error) throw new AbError(500, error.message);
  if (row) return { arm: (row as { arm: string }).arm, new: false, status: exp.status };
  if (exp.status === "paused") return { arm: exp.control, new: false, status: exp.status };
  const computed = assignArm(exp.key, unit, exp.arms);
  // A client that fell back offline used the same function, so its arm matches; honour
  // it anyway when it names a real arm, so what the user saw is what gets counted.
  const arm = typeof hint?.arm === "string" && exp.arms.some((a) => a.key === hint.arm) ? hint.arm : computed;
  const { error: insErr } = await sb.from("ab_assignments").insert({ experiment_id: exp.id, unit_hash: uh, arm, offline: !!hint?.offline });
  if (insErr) {
    const { data: again } = await sb.from("ab_assignments").select("arm").eq("experiment_id", exp.id).eq("unit_hash", uh).maybeSingle();
    if (again) return { arm: (again as { arm: string }).arm, new: false, status: exp.status };
    throw new AbError(500, insErr.message);
  }
  return { arm, new: true, status: exp.status };
}

export async function assignByKey(sb: SB, ownerId: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const exp = await requireExperiment(sb, ownerId, b.experiment);
  const r = await assignUnit(sb, exp, b.unit);
  return { experiment: exp.key, ...r };
}

export type EventInput = { experiment?: unknown; unit?: unknown; type?: unknown; name?: unknown; value?: unknown; arm?: unknown; id?: unknown };

/** Validate one event's shape (no database). Throws AbError(400). */
export function parseEvent(e: EventInput): { type: EventType; name: string | null; value: number | null; dedupe: string | null } {
  const type = String(e.type ?? "") as EventType;
  if (!EVENT_TYPES.includes(type)) throw new AbError(400, `type must be one of ${EVENT_TYPES.join(", ")}`);
  let name: string | null = null;
  if (e.name !== undefined && e.name !== null) {
    name = String(e.name);
    if (!NAME_RE.test(name)) throw new AbError(400, "name must be 1-64 chars of a-z, 0-9, '.', '_', ':' or '-'");
  }
  if (type === "event" && !name) throw new AbError(400, 'an "event" needs a name (e.g. "voice_meeting")');
  let value: number | null = null;
  if (e.value !== undefined && e.value !== null) {
    value = Number(e.value);
    if (!Number.isFinite(value) || Math.abs(value) > 1e9) throw new AbError(400, "value must be a finite number");
  }
  if (type === "revenue" && value === null) throw new AbError(400, "a revenue event needs a value (the amount)");
  let dedupe: string | null = null;
  if (e.id !== undefined && e.id !== null) {
    dedupe = String(e.id);
    if (!dedupe || dedupe.length > 200) throw new AbError(400, "id must be 1-200 chars");
  }
  return { type, name, value, dedupe };
}

/**
 * Record events. Each one assigns its unit first (sticky), so an event for a unit the
 * product never called /assign for still lands in the right arm. Events on a stopped
 * or paused experiment are refused (409) rather than counted against a frozen result.
 */
export async function recordEvents(sb: SB, ownerId: string, events: EventInput[]) {
  if (events.length === 0) throw new AbError(400, "no events");
  if (events.length > MAX_BATCH) throw new AbError(400, `at most ${MAX_BATCH} events per call`);
  const cache = new Map<string, Experiment>();
  const results: Array<{ arm: string; duplicate: boolean }> = [];
  for (const e of events) {
    const parsed = parseEvent(e);
    const key = String(e.experiment ?? "");
    let exp = cache.get(key);
    if (!exp) {
      exp = await requireExperiment(sb, ownerId, key);
      cache.set(key, exp);
    }
    if (exp.status !== "running") throw new AbError(409, `experiment ${exp.key} is ${exp.status}; events are not recorded`);
    const { arm } = await assignUnit(sb, exp, e.unit, { arm: e.arm, offline: e.arm !== undefined });
    const uh = unitHash(exp.id, parseUnit(e.unit));
    const { error } = await sb.from("ab_events").insert({
      experiment_id: exp.id,
      unit_hash: uh,
      arm,
      type: parsed.type,
      name: parsed.name,
      value: parsed.value,
      dedupe_key: parsed.dedupe,
    });
    if (error) {
      if (error.code === "23505") {
        results.push({ arm, duplicate: true });
        continue;
      }
      throw new AbError(500, error.message);
    }
    results.push({ arm, duplicate: false });
  }
  return results;
}

type CountRow = { arm: string; assigned: number | string; exposed: number | string; converted: number | string; revenue: number | string | null; events: Record<string, { units: number; count: number }> | null };

/** Per-arm counts and the summary (rates, CI, z test, probability to beat, verdict). */
export async function experimentStats(sb: SB, exp: Experiment): Promise<Summary> {
  const { data, error } = await sb.rpc("ab_arm_counts", { p_experiment: exp.id });
  if (error) throw new AbError(500, error.message);
  const rows = new Map(((data ?? []) as CountRow[]).map((r) => [r.arm, r]));
  // Every declared arm appears, in declaration order, even before it has data.
  const order = [...exp.arms.map((a) => a.key), ...[...rows.keys()].filter((k) => !exp.arms.some((a) => a.key === k))];
  const counts: ArmCounts[] = order.map((arm) => {
    const r = rows.get(arm);
    return {
      arm,
      assigned: Number(r?.assigned ?? 0),
      exposed: Number(r?.exposed ?? 0),
      converted: Number(r?.converted ?? 0),
      revenue: Number(r?.revenue ?? 0),
      events: r?.events ?? {},
    };
  });
  return summarize(counts, { control: exp.control, minPerArm: exp.min_per_arm });
}

/** Public shape of an experiment (no owner id). */
export function experimentView(exp: Experiment) {
  const { owner_id: _owner, ...rest } = exp;
  return rest;
}
