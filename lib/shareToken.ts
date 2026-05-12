import crypto from "node:crypto";

export function newShareToken(): string {
  // 24-char url-safe token, ~143 bits of entropy.
  return crypto.randomBytes(18).toString("base64url");
}
