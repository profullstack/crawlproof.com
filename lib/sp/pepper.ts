// SP_TOKEN_PEPPER rotation.
//
// Every token family (crp_ API tokens, oa_ affiliate tokens, cpa_ actor tokens
// and their email-verify tokens) stores sha256(material || pepper). Changing
// the pepper would orphan every stored hash, so rotation runs with two:
//
//   SP_TOKEN_PEPPER           the current pepper: every new hash uses it
//   SP_TOKEN_PEPPER_PREVIOUS  the old one: still accepted on lookup only
//
// A lookup tries both hashes; a row that matched on the previous one is
// re-hashed to the current pepper there and then. Unset the previous pepper
// when the window closes: any token not used inside it stops working.

import crypto from "node:crypto";
import { env } from "../env";

/** sha256hex(material + pepper). */
export function pepperedHash(material: string, pepper: string): string {
  return crypto.createHash("sha256").update(material + pepper, "utf8").digest("hex");
}

/** The current pepper; throws when unset (a misconfiguration, not a bad token). */
export function currentPepper(): string {
  if (!env.spTokenPepper) throw new Error("SP_TOKEN_PEPPER not set.");
  return env.spTokenPepper;
}

/** The pepper being rotated out, or null when no rotation is in progress. */
export function previousPepper(): string | null {
  const p = env.spTokenPepperPrevious;
  return p && p !== env.spTokenPepper ? p : null;
}

export type LookupHashes = { current: string; all: string[] };

/** Hashes to look a token up by: the current pepper's, then the previous one's. */
export function lookupHashes(material: string): LookupHashes {
  const current = pepperedHash(material, currentPepper());
  const prev = previousPepper();
  return { current, all: prev ? [current, pepperedHash(material, prev)] : [current] };
}
