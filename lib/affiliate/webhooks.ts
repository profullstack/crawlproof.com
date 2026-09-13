// Outbound webhooks to affiliates that gave a URL at join. Queued in
// affiliate_events, delivered by the cron with backoff, signed with the
// Ed25519 key in OPENAFFILIATE_SIGNING_KEY when it is set (spec, "Webhooks").

import crypto from "node:crypto";
import { serviceClient } from "../supabase/service";
import { env } from "../env";
import type { Membership } from "./memberships";

type Svc = ReturnType<typeof serviceClient>;

export const KEY_ID = "openaffiliate-2026-09";

// PKCS#8 DER prefix for an Ed25519 private key; the 32-byte seed follows.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function seed(): Buffer | null {
  if (!env.openaffiliateSigningKey) return null;
  const b = Buffer.from(env.openaffiliateSigningKey, "base64url");
  return b.length === 32 ? b : null;
}

export function privateKey(): crypto.KeyObject | null {
  const s = seed();
  if (!s) return null;
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, s]), format: "der", type: "pkcs8" });
}

/** The public half as a JWK, for /.well-known/openaffiliate-jwks.json. */
export function publicJwk(): Record<string, unknown> | null {
  const priv = privateKey();
  if (!priv) return null;
  const jwk = crypto.createPublicKey(priv).export({ format: "jwk" }) as Record<string, unknown>;
  return { ...jwk, kid: KEY_ID, use: "sig", alg: "EdDSA" };
}

export function signBody(body: string): string | null {
  const priv = privateKey();
  if (!priv) return null;
  return crypto.sign(null, Buffer.from(body, "utf8"), priv).toString("base64url");
}

/** Verify a signature made by signBody against a JWK (the affiliate side). */
export function verifySignature(body: string, signatureHeader: string | null, jwk: Record<string, unknown>): boolean {
  if (!signatureHeader) return false;
  const m = signatureHeader.match(/ed25519=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  try {
    const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
    return crypto.verify(null, Buffer.from(body, "utf8"), key, Buffer.from(m[1], "base64url"));
  } catch {
    return false;
  }
}

export type AffiliateEventName =
  | "membership.approved"
  | "membership.refused"
  | "membership.ended"
  | "conversion.recorded"
  | "conversion.approved"
  | "conversion.reversed"
  | "payout.sent"
  | "program.changed";

/** Queue an event for a membership. No webhook URL means nothing is queued. */
export async function queueEvent(membership: Membership, event: AffiliateEventName, body: Record<string, unknown>): Promise<void> {
  if (!membership.webhookUrl) return;
  const payload = {
    event,
    at: new Date().toISOString(),
    merchant: env.siteUrl.replace(/\/$/, ""),
    program: membership.program,
    membership: membership.id,
    ...body,
  };
  await serviceClient().from("affiliate_events").insert({ membership_id: membership.id, event, payload });
}

const MAX_ATTEMPTS = 10;
const MAX_AGE_MS = 26 * 3_600_000;

/** Deliver what is due. Backoff doubles from five minutes and gives up after a day. */
export async function deliverDue(svc: Svc, now = new Date()): Promise<{ delivered: number; failed: number }> {
  const { data: due } = await svc
    .from("affiliate_events")
    .select("id, membership_id, payload, attempts, created_at")
    .is("delivered_at", null)
    .lte("next_attempt_at", now.toISOString())
    .lt("attempts", MAX_ATTEMPTS)
    .gte("created_at", new Date(now.getTime() - MAX_AGE_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(200);
  let delivered = 0;
  let failed = 0;
  const urls = new Map<string, string | null>();
  for (const e of (due ?? []) as Array<{ id: string; membership_id: string; payload: unknown; attempts: number }>) {
    let url = urls.get(e.membership_id);
    if (url === undefined) {
      const { data: m } = await svc.from("affiliate_memberships").select("webhook_url").eq("id", e.membership_id).maybeSingle();
      const resolved: string | null = m?.webhook_url ?? null;
      url = resolved;
      urls.set(e.membership_id, resolved);
    }
    if (!url) {
      await svc.from("affiliate_events").update({ delivered_at: now.toISOString(), last_error: "no webhook url" }).eq("id", e.id);
      continue;
    }
    const body = JSON.stringify(e.payload);
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "openaffiliate-merchant (crawlproof.com)" };
    const sig = signBody(body);
    if (sig) {
      headers["x-openaffiliate-signature"] = `ed25519=${sig}`;
      headers["x-openaffiliate-key"] = KEY_ID;
    }
    let ok = false;
    let error = "";
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000), redirect: "manual" });
      ok = res.ok;
      if (!ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (ok) {
      delivered++;
      await svc.from("affiliate_events").update({ delivered_at: now.toISOString(), attempts: e.attempts + 1, last_error: null }).eq("id", e.id);
    } else {
      failed++;
      const attempts = e.attempts + 1;
      const delayMs = Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** attempts);
      await svc
        .from("affiliate_events")
        .update({ attempts, next_attempt_at: new Date(now.getTime() + delayMs).toISOString(), last_error: error.slice(0, 300) })
        .eq("id", e.id);
    }
  }
  return { delivered, failed };
}
