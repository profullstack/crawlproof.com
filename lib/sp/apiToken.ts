// API token minting + verification.
//
// Token shape: `crp_` prefix + 43 base64url chars from 32 bytes of
// crypto-random. The prefix is to make tokens visually distinct from
// other secrets and easy to grep for in leaked logs.
//
// Storage: we never persist the plaintext token. We persist
//   prefix     — first 8 chars of the plaintext (for UI disambig)
//   token_hash — sha256hex(plaintext || SP_TOKEN_PEPPER)
//
// Why SHA-256 (not argon2) is fine here: the plaintext carries 256
// bits of entropy from crypto.randomBytes(32). Brute-forcing the hash
// to recover the plaintext is computationally infeasible regardless
// of how fast the hash is. The pepper means a DB leak alone is also
// useless — the attacker also needs SP_TOKEN_PEPPER from app env.

import crypto from "node:crypto";
import { env } from "../env";

const PREFIX = "crp_";
const PREFIX_DISPLAY_LEN = 8; // including the "crp_" prefix

export type MintedToken = {
  plaintext: string; // shown to the user ONCE; never re-derivable.
  prefix: string;
  hash: string;
};

export function mintApiToken(): MintedToken {
  if (!env.spTokenPepper) {
    throw new Error(
      "SP_TOKEN_PEPPER not set. Generate with `openssl rand -base64 32`.",
    );
  }
  const random = crypto.randomBytes(32).toString("base64url");
  const plaintext = `${PREFIX}${random}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, PREFIX_DISPLAY_LEN),
    hash: hashApiToken(plaintext),
  };
}

export function hashApiToken(plaintext: string): string {
  if (!env.spTokenPepper) {
    throw new Error("SP_TOKEN_PEPPER not set.");
  }
  return crypto
    .createHash("sha256")
    .update(plaintext + env.spTokenPepper, "utf8")
    .digest("hex");
}

// Reject obviously-malformed tokens before doing a DB roundtrip. Real
// validation is the hash lookup; this is just a cheap shape check.
export function isApiTokenShape(s: string | null | undefined): boolean {
  if (!s) return false;
  return s.startsWith(PREFIX) && s.length >= 32 && s.length <= 128;
}
