// PKCE — Proof Key for Code Exchange (RFC 7636) S256 method.
// Required by X (Twitter), Threads, and TikTok OAuth2 flows; recommended
// for the others. Same shape for all callers: generate a verifier per
// authorization request, send the S256 challenge in /authorize, send
// the verifier back in /token.

import crypto from "node:crypto";

export type PkcePair = {
  verifier: string; // 43-128 char unreserved URL chars
  challenge: string; // base64url(sha256(verifier))
};

// 32 bytes of randomness → base64url is 43 chars. Within RFC 7636's
// 43-128 char window for code_verifier.
export function generatePkcePair(): PkcePair {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}
