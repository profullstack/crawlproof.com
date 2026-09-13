// oa_ tokens: the bearer credential a membership reads its ledger with.
// Same storage rule as API tokens (lib/sp/apiToken.ts): never the plaintext,
// only sha256(plaintext || SP_TOKEN_PEPPER) and an 8-char prefix for the UI.

import crypto from "node:crypto";
import { env } from "../env";
import { TOKEN_PREFIX } from "./spec";

export type MintedAffiliateToken = { plaintext: string; prefix: string; hash: string };

export function mintAffiliateToken(): MintedAffiliateToken {
  if (!env.spTokenPepper) throw new Error("SP_TOKEN_PEPPER not set.");
  const plaintext = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  return { plaintext, prefix: plaintext.slice(0, 8), hash: hashAffiliateToken(plaintext) };
}

export function hashAffiliateToken(plaintext: string): string {
  if (!env.spTokenPepper) throw new Error("SP_TOKEN_PEPPER not set.");
  return crypto.createHash("sha256").update(plaintext + env.spTokenPepper, "utf8").digest("hex");
}

export function isAffiliateTokenShape(s: string | null | undefined): boolean {
  return !!s && s.startsWith(TOKEN_PREFIX) && s.length >= 32 && s.length <= 128;
}
