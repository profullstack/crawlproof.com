import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";

// env is read at call time in lib/affiliate/webhooks, but lib/env.ts is a
// snapshot at import; set the variable before the first import.
const seed = crypto.randomBytes(32).toString("base64url");
process.env.OPENAFFILIATE_SIGNING_KEY = seed;

describe("webhook signing", () => {
  let mod: typeof import("@/lib/affiliate/webhooks");
  beforeEach(async () => {
    mod = await import("@/lib/affiliate/webhooks");
  });
  afterEach(() => {
    delete process.env.OPENAFFILIATE_SIGNING_KEY;
  });

  it("serves a JWK and verifies its own signature", () => {
    const jwk = mod.publicJwk();
    expect(jwk).toMatchObject({ kty: "OKP", crv: "Ed25519", kid: mod.KEY_ID, alg: "EdDSA" });
    const body = JSON.stringify({ event: "conversion.approved", at: "2026-09-13T00:00:00Z" });
    const sig = mod.signBody(body);
    expect(sig).toBeTruthy();
    expect(mod.verifySignature(body, `ed25519=${sig}`, jwk!)).toBe(true);
    expect(mod.verifySignature(body + " ", `ed25519=${sig}`, jwk!)).toBe(false);
    expect(mod.verifySignature(body, null, jwk!)).toBe(false);
    expect(mod.verifySignature(body, "hmac=abc", jwk!)).toBe(false);
  });
});
