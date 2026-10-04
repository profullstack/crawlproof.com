// Declared actors: a visitor saying who it is, and whether it is a person.
//
// Nothing on the wire tells a person from an agent driving a real browser, so
// this is opt-in and on the honor system. An account registers actors (email,
// name, kind) and mints a `cpa_` token per browser or agent; the visitor sends
// the token with the beacon by one of two channels:
//
//   1. the `Crawlproof-Actor` request header  — headless agents (Playwright
//      extraHTTPHeaders, Puppeteer setExtraHTTPHeaders)
//   2. the `actor` field of the beacon body    — stats.js, from the site's
//      localStorage, set by opening the site once with `?crp_actor=<token>`
//      or by `crawlproof('actor', token)` (the dashboard bookmarklet)
//
// No cookie channel, on purpose: the tracker is documented as cookieless and
// the beacon sends `credentials: 'omit'` (tests/contract/stats-js.test.ts).
// The token sits in localStorage next to the visitor id it already keeps.
//
// The token is the credential; a bare email is never accepted, so typing
// someone else's address claims nothing. What a token cannot stop is an owner
// lying about the KIND, which is why applyDeclaration below is asymmetric.
//
// Schema: supabase/migrations/20261004120000_tracker_declared_actors.sql.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { kindFromBucket, type TrackerKind } from "@/lib/tracker/humans";

export type DeclaredKind = "human" | "agent";

export const ACTOR_TOKEN_PREFIX = "cpa_";
export const ACTOR_HEADER = "crawlproof-actor";
/** The URL parameter stats.js lifts into localStorage and strips. */
export const ACTOR_PARAM = "crp_actor";

/** The bucket a declared agent's hit is counted under. Renders "Bot · declared". */
export const DECLARED_AGENT_BUCKET = "bot:declared";

export const DECLARED_DEFINITION =
  "Visitors who opted in and said who they are. Self-declared: an agent is believed, a human is not taken on trust and never overrides bot detection.";

const PREFIX_DISPLAY_LEN = 8;

export type MintedActorToken = { plaintext: string; prefix: string; hash: string };

export function mintActorToken(): MintedActorToken {
  const plaintext = `${ACTOR_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, PREFIX_DISPLAY_LEN),
    hash: hashActorToken(plaintext),
  };
}

/**
 * sha256(domain || token || pepper). Same reasoning as lib/sp/apiToken.ts: 256
 * bits of entropy make a fast hash safe. The "actor:" domain keeps an actor
 * token hash from ever colliding with an API token hash under the same pepper.
 */
export function hashActorToken(plaintext: string): string {
  if (!env.spTokenPepper) throw new Error("SP_TOKEN_PEPPER not set.");
  return crypto
    .createHash("sha256")
    .update(`actor:${plaintext}${env.spTokenPepper}`, "utf8")
    .digest("hex");
}

export function isActorTokenShape(s: string | null | undefined): s is string {
  return !!s && s.startsWith(ACTOR_TOKEN_PREFIX) && s.length >= 36 && s.length <= 128 && /^[A-Za-z0-9_-]+$/.test(s);
}

/**
 * The declared token on a beacon: the header if it carries one (set per agent
 * run, so the most deliberate), else the beacon body.
 */
export function actorTokenFrom(headers: Headers, bodyActor: string | null | undefined): string | null {
  const candidates = [headers.get(ACTOR_HEADER), bodyActor ?? null];
  for (const c of candidates) {
    const t = c?.trim();
    if (isActorTokenShape(t)) return t;
  }
  return null;
}

/**
 * The bucket and kind a hit is counted under once its declaration has had its
 * say. The only rule that matters, and it is asymmetric on purpose:
 *
 *   agent  -> believed. A hit detection called human moves to bot:declared.
 *             Nobody gains by claiming to be a bot; the worst a liar does is
 *             shrink their own human count.
 *   human  -> recorded, never trusted. The bucket stands. If detection (user
 *             agent or scripted cap) already called it a bot, it stays a bot
 *             and counts as a contradiction against the actor, which is the
 *             signal that a token is being used by something it should not be.
 *
 * So a declaration can only ever move traffic toward the bot side.
 */
export function applyDeclaration(
  bucket: string,
  declared: DeclaredKind | null,
): { bucket: string; kind: TrackerKind; contradiction: boolean } {
  const kind = kindFromBucket(bucket);
  if (declared === "agent" && kind === "human") {
    return { bucket: DECLARED_AGENT_BUCKET, kind: "bot", contradiction: false };
  }
  return { bucket, kind, contradiction: declared === "human" && kind === "bot" };
}

export type ResolvedActor = { actorId: string; tokenId: string; kind: DeclaredKind };

// A beacon fires several times per page view; a token is looked up once a
// minute per process, not once per scroll. Revocation therefore takes up to
// TTL to bite, which is fine for analytics.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 5_000;
const cache = new Map<string, { at: number; value: ResolvedActor | null }>();

/** Test hook. */
export function clearActorCache() {
  cache.clear();
}

/**
 * The live actor behind a token, or null for unknown, revoked, or an actor
 * whose owner revoked it. Never throws: a failed lookup is "undeclared".
 */
export async function resolveActor(sb: SupabaseClient, token: string): Promise<ResolvedActor | null> {
  let hash: string;
  try {
    hash = hashActorToken(token);
  } catch {
    return null;
  }
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value: ResolvedActor | null = null;
  try {
    const { data } = await sb
      .from("tracker_actor_tokens")
      .select("id, revoked_at, actor:tracker_actors!inner(id, kind, revoked_at)")
      .eq("token_hash", hash)
      .maybeSingle();
    const row = data as
      | { id: string; revoked_at: string | null; actor: { id: string; kind: string; revoked_at: string | null } | null }
      | null;
    if (row && !row.revoked_at && row.actor && !row.actor.revoked_at) {
      const kind = row.actor.kind === "agent" ? "agent" : row.actor.kind === "human" ? "human" : null;
      if (kind) value = { actorId: row.actor.id, tokenId: row.id, kind };
    }
    if (value) {
      void sb
        .from("tracker_actor_tokens")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", value.tokenId)
        .then(() => undefined);
    }
  } catch {
    return null;
  }

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(hash, { at: Date.now(), value });
  return value;
}

/** A short, human label for the token, so the list says which browser it is. */
export function browserLabel(ua: string | null, now = new Date()): string {
  const u = ua ?? "";
  const browser = /Edg\//.test(u) ? "Edge" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "Browser";
  const os = /Android/.test(u) ? "Android" : /iPhone|iPad/.test(u) ? "iOS" : /Mac OS X/.test(u) ? "macOS" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : "";
  return `Browser: ${browser}${os ? ` on ${os}` : ""}, ${now.toISOString().slice(0, 10)}`;
}

// ---------------------------------------------------------------- validation

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 320) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function parseDeclaredKind(raw: unknown): DeclaredKind | null {
  return raw === "human" || raw === "agent" ? raw : null;
}

/** Per-kind totals as tracker_declared_totals returns them, coerced. */
export type DeclaredTotals = Record<DeclaredKind, { actors: number; events: number; pageviews: number; contradictions: number }>;

export function toDeclaredTotals(rows: unknown): DeclaredTotals {
  const out: DeclaredTotals = {
    human: { actors: 0, events: 0, pageviews: 0, contradictions: 0 },
    agent: { actors: 0, events: 0, pageviews: 0, contradictions: 0 },
  };
  if (!Array.isArray(rows)) return out;
  for (const r of rows as Record<string, unknown>[]) {
    const kind = parseDeclaredKind(r.declared_kind);
    if (!kind) continue;
    for (const key of ["actors", "events", "pageviews", "contradictions"] as const) {
      const n = Number(r[key]);
      out[kind][key] = Number.isFinite(n) ? n : 0;
    }
  }
  return out;
}
