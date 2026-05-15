import crypto from "node:crypto";

// Bearer token sent in the webhook Authorization header. 32 bytes of
// crypto-random data, base64url-encoded for safe transport. The cp_lx_
// prefix lets receivers (and us) recognize the source at a glance and
// scan for accidental leaks in repos.
export function generateWebhookSecret(): string {
  return `cp_lx_${crypto.randomBytes(32).toString("base64url")}`;
}
