// oa_ tokens: the bearer credential a membership reads its ledger with.
// Same storage rule as API tokens (lib/sp/apiToken.ts): never the plaintext,
// only sha256(plaintext || SP_TOKEN_PEPPER) and an 8-char prefix for the UI.

import crypto from "node:crypto";
import { env } from "../env";
import { TOKEN_PREFIX } from "./spec";
import { currentPepper, lookupHashes, pepperedHash, type LookupHashes } from "../sp/pepper";

export type MintedAffiliateToken = { plaintext: string; prefix: string; hash: string };

export function mintAffiliateToken(): MintedAffiliateToken {
  if (!env.spTokenPepper) throw new Error("SP_TOKEN_PEPPER not set.");
  const plaintext = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  return { plaintext, prefix: plaintext.slice(0, 8), hash: hashAffiliateToken(plaintext) };
}

export function hashAffiliateToken(plaintext: string): string {
  return pepperedHash(plaintext, currentPepper());
}

/** Current hash plus, mid pepper rotation, the previous one (lib/sp/pepper.ts). */
export function affiliateTokenLookupHashes(plaintext: string): LookupHashes {
  return lookupHashes(plaintext);
}

export function isAffiliateTokenShape(s: string | null | undefined): boolean {
  return !!s && s.startsWith(TOKEN_PREFIX) && s.length >= 32 && s.length <= 128;
}
