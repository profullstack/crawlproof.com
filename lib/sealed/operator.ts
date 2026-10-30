/**
 * Operator keys (ours, not a user's): COINPAY_API_KEY for billing and payouts,
 * SMSHUB_API_KEY for outbound outreach, and X402_PRIVATE_KEY for the crawler
 * wallet. Same rule as users: the operator is
 * just an admin account with a key passphrase. Each value lives sealed in
 * operator_sealed_secret, sealed to that admin's key, and opens only while the
 * admin is unlocked (default 7d for operator unlocks, Lock any time).
 *
 * While locked the job that needs the key pauses (payouts stay queued, audits
 * fetch without paying) and we raise ONE alert per lock episode: a log line
 * `ALERT crawlproof: operator keys locked, unlock to resume` and, when
 * OPERATOR_ALERT_PHONE is set, the same smshub call the uptime monitors use.
 *
 * Transition: until an admin imports a key (POST /api/keys/operator/import),
 * the env value is still used, unless OPERATOR_ENV_FALLBACK=off. Once a sealed
 * row exists the env value is never read for that name, so the env var can be
 * deleted from app.env. No key is generated, rotated or moved here.
 */

// Loaded lazily so importing this module never pulls lib/env in early.
async function serviceClient() {
  return (await import("@/lib/supabase/service")).serviceClient();
}
import { canOpen, decryptSecret, encryptSecret } from "./vault";

export const OPERATOR_SECRET_NAMES = [
  "COINPAY_API_KEY",
  "SMSHUB_API_KEY",
  "X402_PRIVATE_KEY",
] as const;
export type OperatorSecretName = (typeof OPERATOR_SECRET_NAMES)[number];

const FIELD = (name: string) => `operator.${name}`;

const ALERTED = Symbol.for("crawlproof.sealed.operatorAlerted");
type G = typeof globalThis & { [ALERTED]?: { on: boolean } };
function alerted(): { on: boolean } {
  const g = globalThis as G;
  if (!g[ALERTED]) g[ALERTED] = { on: false };
  return g[ALERTED]!;
}

export function resetOperatorAlert(): void {
  alerted().on = false;
}

export function envFallbackEnabled(): boolean {
  const v = (process.env[["OPERATOR", "ENV", "FALLBACK"].join("_")] ?? "on").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false");
}

/** Once per lock episode: log line for the fleet log watch + optional phone call. */
export function noteOperatorLocked(what: string, fetchImpl: typeof fetch = fetch): void {
  if (alerted().on) return;
  alerted().on = true;
  const msg = "crawlproof: operator keys locked, unlock to resume";
  console.error(`ALERT ${msg} (${what})`);
  const phone = process.env.OPERATOR_ALERT_PHONE;
  const key = process.env.SMSHUB_ALERT_API_KEY;
  if (!phone || !key) return;
  const base = (process.env.SMSHUB_URL ?? "https://smshub.dev").replace(/\/$/, "");
  fetchImpl(`${base}/api/v1/alerts`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ to: phone, message: msg, severity: "critical" }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {});
}

type Row = { name: string; owner_id: string; enc_value: string };

export type OperatorRowLoader = (name: string) => Promise<Row | null>;
// Ciphertext rows cached for a minute so a paid crawl does not hit the DB per
// request. The cache holds only sealed values, never plaintext.
const rowCache = new Map<string, { row: Row | null; at: number }>();
let rowLoader: OperatorRowLoader = async (name) => {
  const hit = rowCache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.row;
  const { data, error } = await (await serviceClient()).from("operator_sealed_secret").select("name, owner_id, enc_value").eq("name", name).maybeSingle();
  if (error) throw new Error(error.message);
  const row = (data as Row | null) ?? null;
  rowCache.set(name, { row, at: Date.now() });
  return row;
};
export function setOperatorRowLoaderForTests(fn: OperatorRowLoader | null): void {
  if (fn) rowLoader = fn;
}

function envValue(name: string): string | null {
  const v =
    process.env[name] ??
    (name === "SMSHUB_API_KEY" ? process.env.SMSHUB_ALERT_API_KEY : undefined);
  return v && v.trim() ? v : null;
}

/**
 * The operator secret, or null while it cannot be used (locked, or not
 * configured). Callers must treat null as "pause this job", not as an error.
 */
export async function getOperatorSecret(name: OperatorSecretName): Promise<string | null> {
  const row = await rowLoader(name).catch(() => null);
  if (row) {
    if (!canOpen(row.owner_id)) {
      noteOperatorLocked(name);
      return null;
    }
    try {
      return await decryptSecret(row.enc_value, { ownerId: row.owner_id, field: FIELD(name) });
    } catch {
      noteOperatorLocked(name);
      return null;
    }
  }
  return envFallbackEnabled() ? envValue(name) : null;
}

/** Admin action: seal the CURRENT env values under the admin's own key. Never prints them. */
export async function importOperatorSecretsFromEnv(adminId: string, names: readonly OperatorSecretName[] = OPERATOR_SECRET_NAMES) {
  const sb = await serviceClient();
  const imported: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const v = envValue(name);
    if (!v) {
      missing.push(name);
      continue;
    }
    const enc_value = await encryptSecret(v, { ownerId: adminId, field: FIELD(name) });
    const { error } = await sb
      .from("operator_sealed_secret")
      .upsert({ name, owner_id: adminId, enc_value, updated_at: new Date().toISOString() }, { onConflict: "name" });
    if (error) throw new Error(`could not store ${name}: ${error.message}`);
    rowCache.delete(name);
    imported.push(name);
  }
  return { imported, missing };
}

/** Seal a newly supplied operator key without routing it through an env file. */
export async function saveOperatorSecret(
  name: OperatorSecretName,
  value: string,
  ownerId: string,
): Promise<void> {
  const plaintext = value.trim();
  if (!plaintext) throw new Error(`${name} is required.`);
  const enc_value = await encryptSecret(plaintext, { ownerId, field: FIELD(name) });
  const { error } = await (await serviceClient())
    .from("operator_sealed_secret")
    .upsert({ name, owner_id: ownerId, enc_value, updated_at: new Date().toISOString() }, { onConflict: "name" });
  if (error) throw new Error(`could not store ${name}: ${error.message}`);
  rowCache.delete(name);
}

/** Remove a sealed operator key; provider connection tombstones suppress env fallback. */
export async function clearOperatorSecret(name: OperatorSecretName): Promise<void> {
  const { error } = await (await serviceClient())
    .from("operator_sealed_secret")
    .delete()
    .eq("name", name);
  if (error) throw new Error(`could not clear ${name}: ${error.message}`);
  rowCache.delete(name);
}

export async function operatorStatus() {
  const rows = await Promise.all(
    OPERATOR_SECRET_NAMES.map((name) => rowLoader(name).catch(() => null)),
  );
  return OPERATOR_SECRET_NAMES.map((name, index) => {
    const r = rows[index];
    return {
      name,
      sealed: !!r,
      unlocked: r ? canOpen(r.owner_id) : false,
      envFallback: !r && envFallbackEnabled() && !!envValue(name),
      updatedAt: r?.updated_at ?? null,
    };
  });
}
