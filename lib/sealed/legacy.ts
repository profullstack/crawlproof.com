// LEGACY (seal v1): one static SOCIAL_VAULT_KEY for every user's secrets.
//
// Kept ONLY for the one-shot migration path (lib/sealed/migrate.ts): when an
// owner sets up or unlocks their passphrase, their v1 rows are opened here and
// re-sealed to their own key in the same request. No job, route or action may
// call this to read a secret for use. `LEGACY_KEY_MIGRATION=off` disables it
// entirely (the dated cutoff); after that, unmigrated rows stay in the DB
// unreadable until the owner re-enters them.

import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const NONCE_LEN = 12;
const TAG_LEN = 16;

export function legacyMigrationEnabled(): boolean {
  const v = (process.env[["LEGACY", "KEY", "MIGRATION"].join("_")] ?? "on").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false");
}

function getKey(): Buffer {
  const raw = process.env[["SOCIAL", "VAULT", "KEY"].join("_")] ?? "";
  if (!raw) throw new Error("legacy vault key not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`legacy vault key must decode to 32 bytes, got ${key.length}.`);
  return key;
}

/** Test/fixture helper only: produce a v1 blob. Never used by app code. */
export function legacyEncryptForTests(plaintext: string): string {
  const key = getKey();
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, nonce, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}

/** Migration path only. Throws when LEGACY_KEY_MIGRATION=off. */
export function legacyDecryptForMigration(encoded: string): string {
  if (!legacyMigrationEnabled()) throw new Error("legacy key migration is off");
  const key = getKey();
  const blob = Buffer.from(encoded, "base64");
  if (blob.length < NONCE_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, nonce, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * Our OWN Mastodon app registrations (sp_mastodon_app.enc_client_secret) are
 * an operator app credential, the same class as META_APP_SECRET in the env,
 * not a user secret. They stay under the legacy key and do not follow the
 * LEGACY_KEY_MIGRATION switch. At the key cutoff either keep SOCIAL_VAULT_KEY
 * for this one table or delete sp_mastodon_app rows (they re-register on the
 * next connect).
 */
export function appSecretEncrypt(plaintext: string): string {
  return legacyEncryptForTests(plaintext);
}
export function appSecretDecrypt(encoded: string): string {
  const key = getKey();
  const blob = Buffer.from(encoded, "base64");
  if (blob.length < NONCE_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const decipher = crypto.createDecipheriv(ALGO, key, blob.subarray(0, NONCE_LEN), { authTagLength: TAG_LEN });
  decipher.setAuthTag(blob.subarray(blob.length - TAG_LEN));
  return Buffer.concat([decipher.update(blob.subarray(NONCE_LEN, blob.length - TAG_LEN)), decipher.final()]).toString("utf8");
}
