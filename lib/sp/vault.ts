// Static-key AES-GCM at-rest encryption for OAuth tokens etc.
// Phase 1 simplicity — one key for all users, all platforms.
// docs/social-posting-prd.md §5.3 plans the per-user-DEK upgrade for
// when cookie + puppeteer modes land.

import crypto from "node:crypto";
import { env } from "../env";

const ALGO = "aes-256-gcm";
const NONCE_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  if (!env.socialVaultKey) {
    throw new Error(
      "SOCIAL_VAULT_KEY env not set. Generate with `openssl rand -base64 32`.",
    );
  }
  const key = Buffer.from(env.socialVaultKey, "base64");
  if (key.length !== 32) {
    throw new Error(
      `SOCIAL_VAULT_KEY must decode to 32 bytes, got ${key.length}.`,
    );
  }
  return key;
}

// Encrypt a string. Output format: base64(nonce || ciphertext || tag).
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString("base64");
}

// Decrypt the inverse. Throws on tampering (auth tag mismatch).
export function decryptSecret(encoded: string): string {
  const key = getKey();
  const blob = Buffer.from(encoded, "base64");
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new Error("ciphertext too short");
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
