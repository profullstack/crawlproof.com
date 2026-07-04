// Stateless signed tokens for one-click pause / unsubscribe links in every
// alert email. HMAC over a scope + id keyed by a server secret — no extra
// columns, verifiable without a DB round-trip.

import crypto from "node:crypto";
import { env } from "@/lib/env";

function secret(): string {
  // Reuse an existing server secret; cronSecret is server-only and always set
  // in deployed envs. Falls back so local dev without it still functions.
  return env.cronSecret || env.workerSecret || "crawlproof-alerts-dev-secret";
}

function sign(scope: string, id: string): string {
  return crypto
    .createHmac("sha256", secret())
    .update(`${scope}:${id}`)
    .digest("base64url")
    .slice(0, 32);
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function pauseToken(alertId: string): string {
  return sign("pause", alertId);
}

export function verifyPauseToken(alertId: string, token: string): boolean {
  return timingSafeEqual(token, pauseToken(alertId));
}

export function unsubscribeToken(ownerId: string): string {
  return sign("unsub", ownerId);
}

export function verifyUnsubscribeToken(ownerId: string, token: string): boolean {
  return timingSafeEqual(token, unsubscribeToken(ownerId));
}

export function pauseUrl(alertId: string): string {
  return `${env.siteUrl}/api/alerts/pause?alert=${encodeURIComponent(alertId)}&token=${pauseToken(alertId)}`;
}

export function unsubscribeUrl(ownerId: string): string {
  return `${env.siteUrl}/api/alerts/unsubscribe?owner=${encodeURIComponent(ownerId)}&token=${unsubscribeToken(ownerId)}`;
}
