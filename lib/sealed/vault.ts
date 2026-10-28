/**
 * Server-side vault for user secrets (replaces the single SOCIAL_VAULT_KEY).
 *
 *   encryptSecret(plain, { ownerId, field })  seals to the owner's PUBLIC key:
 *     works whether or not the owner is unlocked (OAuth callbacks, refreshes).
 *   decryptSecret(sealed, { ownerId, field }) needs the owner's private key,
 *     which exists only in this process's memory while they are unlocked.
 *
 * Owner = the user whose passphrase seals the secret: sp_account.user_id for
 * social accounts, organizations.owner_id for org secrets, the admin who
 * imported it for operator secrets.
 *
 * Errors are typed so jobs can WAIT instead of failing:
 *   SealRequiredError  owner has no passphrase set up yet
 *   SecretsLockedError owner is locked (restart, TTL ran out, Lock pressed),
 *                      or the row is still a legacy v1 blob awaiting migration.
 */

// Loaded lazily so importing this module never pulls lib/env in early.
async function serviceClient() {
  return (await import("@/lib/supabase/service")).serviceClient();
}
import { isSealRecord, isSealedValue, openWithPrivateKey, sealToPublicKey, type SealRecord } from "./crypto";
import { privateKeyFor } from "./unlockStore";

export type SecretCtx = { ownerId: string; field: string };

export const LOCKED_MESSAGE = "locked: unlock your keys at /dashboard/keys to resume";
export const SEAL_REQUIRED_MESSAGE = "locked: set up your key passphrase at /dashboard/keys to resume";

export class SecretsLockedError extends Error {
  readonly ownerId: string;
  readonly reason: "locked" | "seal_required" | "legacy";
  constructor(ownerId: string, reason: "locked" | "seal_required" | "legacy" = "locked") {
    super(reason === "seal_required" ? SEAL_REQUIRED_MESSAGE : LOCKED_MESSAGE);
    this.name = "SecretsLockedError";
    this.ownerId = ownerId;
    this.reason = reason;
  }
}

export class SealRequiredError extends SecretsLockedError {
  constructor(ownerId: string) {
    super(ownerId, "seal_required");
    this.name = "SealRequiredError";
  }
}

export function isLockedError(err: unknown): err is SecretsLockedError {
  return err instanceof SecretsLockedError || (!!err && typeof err === "object" && (err as { name?: string }).name === "SecretsLockedError");
}

// Public keys are public; caching them is fine. Seal rows change only on setup.
const PUB_KEY = Symbol.for("crawlproof.sealed.pubCache");
type G = typeof globalThis & { [PUB_KEY]?: Map<string, string> };
function pubCache(): Map<string, string> {
  const g = globalThis as G;
  if (!g[PUB_KEY]) g[PUB_KEY] = new Map();
  return g[PUB_KEY]!;
}

export function forgetCachedSeal(ownerId: string): void {
  pubCache().delete(ownerId);
}

/** Injectable for tests. */
export type SealLoader = (ownerId: string) => Promise<SealRecord | null>;
let loader: SealLoader = async (ownerId) => {
  const { data } = await (await serviceClient()).from("user_key_seal").select("seal").eq("user_id", ownerId).maybeSingle();
  const seal = (data as { seal?: unknown } | null)?.seal;
  return isSealRecord(seal) ? seal : null;
};
export function setSealLoaderForTests(fn: SealLoader | null): void {
  loader = fn ?? loader;
  pubCache().clear();
}

export async function loadSeal(ownerId: string): Promise<SealRecord | null> {
  return loader(ownerId);
}

async function publicKeyFor(ownerId: string): Promise<string | null> {
  const hit = pubCache().get(ownerId);
  if (hit) return hit;
  const seal = await loader(ownerId);
  if (!seal) return null;
  pubCache().set(ownerId, seal.public_key);
  return seal.public_key;
}

export async function hasSeal(ownerId: string): Promise<boolean> {
  return (await publicKeyFor(ownerId)) !== null;
}

/** Seal a secret to its owner. Throws SealRequiredError if the owner has no passphrase yet. */
export async function encryptSecret(plaintext: string, ctx: SecretCtx): Promise<string> {
  const pub = await publicKeyFor(ctx.ownerId);
  if (!pub) throw new SealRequiredError(ctx.ownerId);
  return sealToPublicKey(pub, plaintext, ctx.ownerId, ctx.field);
}

/** Open a sealed secret. Throws SecretsLockedError while the owner is locked or the row is unmigrated. */
export async function decryptSecret(encoded: string, ctx: SecretCtx): Promise<string> {
  if (!isSealedValue(encoded)) {
    // A legacy v1 blob: readable only by the owner's migration (lib/sealed/migrate.ts).
    throw new SecretsLockedError(ctx.ownerId, (await hasSeal(ctx.ownerId)) ? "legacy" : "seal_required");
  }
  const key = privateKeyFor(ctx.ownerId);
  if (!key) throw new SecretsLockedError(ctx.ownerId, "locked");
  return openWithPrivateKey(key, encoded, ctx.ownerId, ctx.field);
}

/** True when the owner's secrets can be opened right now. */
export function canOpen(ownerId: string): boolean {
  return privateKeyFor(ownerId) !== null;
}

/** organizations.owner_id for an org; org secrets are sealed to the owner's key. */
export async function orgOwnerId(organizationId: string): Promise<string> {
  const { data } = await (await serviceClient()).from("organizations").select("owner_id").eq("id", organizationId).maybeSingle();
  const owner = (data as { owner_id?: string } | null)?.owner_id;
  if (!owner) throw new Error("organization not found");
  return owner;
}
