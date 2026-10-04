// Declared actors: the reads and writes behind the API, the dashboard and the
// CLI. Every function takes the service client and the owner's user id and
// scopes by it; callers authenticate first (lib/tracker/actorAuth.ts).
//
// Model and trust rule: lib/tracker/actors.ts.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { sendActorVerifyEmail } from "@/lib/email";
import type { TrackerRange } from "@/lib/tracker/ranges";
import {
  type DeclaredKind,
  type DeclaredTotals,
  hashActorToken,
  mintActorToken,
  normalizeEmail,
  parseDeclaredKind,
  toDeclaredTotals,
} from "@/lib/tracker/actors";

type Sb = SupabaseClient;

export type ActorToken = {
  id: string;
  prefix: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
};

export type Actor = {
  id: string;
  email: string;
  name: string;
  kind: DeclaredKind;
  operator_actor_id: string | null;
  visibility: "private" | "public";
  email_verified: boolean;
  created_at: string;
  tokens: ActorToken[];
  /** Last 30 days across every project. */
  last30: { events: number; pageviews: number; contradictions: number; sites: number };
};

export type StoreResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const ACTOR_COLUMNS = "id, email, name, kind, operator_actor_id, visibility, email_verified_at, created_at";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function ownerEmail(sb: Sb, ownerId: string): Promise<string | null> {
  const { data } = await sb.from("profiles").select("email").eq("id", ownerId).maybeSingle();
  return normalizeEmail((data as { email?: string } | null)?.email);
}

export async function listActors(sb: Sb, ownerId: string): Promise<StoreResult<Actor[]>> {
  const { data, error } = await sb
    .from("tracker_actors")
    .select(`${ACTOR_COLUMNS}, tracker_actor_tokens(id, prefix, label, created_at, last_used_at, revoked_at)`)
    .eq("owner_id", ownerId)
    .is("revoked_at", null)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, status: 500, error: error.message };
  const rows = (data ?? []) as Record<string, unknown>[];

  const ids = rows.map((r) => r.id as string);
  const usage = new Map<string, Actor["last30"]>();
  if (ids.length) {
    const { data: stats } = await sb
      .from("tracker_actor_daily_stats")
      .select("actor_id, project_id, events, pageviews, contradictions")
      .in("actor_id", ids)
      .gte("day", daysAgo(30));
    const sites = new Map<string, Set<string>>();
    for (const s of (stats ?? []) as Record<string, unknown>[]) {
      const id = s.actor_id as string;
      const u = usage.get(id) ?? { events: 0, pageviews: 0, contradictions: 0, sites: 0 };
      u.events += Number(s.events) || 0;
      u.pageviews += Number(s.pageviews) || 0;
      u.contradictions += Number(s.contradictions) || 0;
      usage.set(id, u);
      const set = sites.get(id) ?? new Set<string>();
      set.add(s.project_id as string);
      sites.set(id, set);
    }
    for (const [id, set] of sites) usage.get(id)!.sites = set.size;
  }

  return {
    ok: true,
    value: rows.map((r) => ({
      id: r.id as string,
      email: r.email as string,
      name: (r.name as string) ?? "",
      kind: r.kind as DeclaredKind,
      operator_actor_id: (r.operator_actor_id as string | null) ?? null,
      visibility: r.visibility === "public" ? "public" : "private",
      email_verified: !!r.email_verified_at,
      created_at: r.created_at as string,
      tokens: ((r.tracker_actor_tokens as Record<string, unknown>[] | null) ?? [])
        .filter((t) => !t.revoked_at)
        .map((t) => ({
          id: t.id as string,
          prefix: t.prefix as string,
          label: (t.label as string) ?? "",
          created_at: t.created_at as string,
          last_used_at: (t.last_used_at as string | null) ?? null,
        })),
      last30: usage.get(r.id as string) ?? { events: 0, pageviews: 0, contradictions: 0, sites: 0 },
    })),
  };
}

export type CreateActorInput = {
  email: unknown;
  kind: unknown;
  name?: unknown;
  /** Another of the owner's actors, by id or email: the human an agent acts for. */
  operator?: unknown;
  visibility?: unknown;
  /** Label for a first token, minted in the same call. Omit for none. */
  tokenLabel?: unknown;
};

export type CreatedActor = {
  actor: { id: string; email: string; kind: DeclaredKind; email_verified: boolean };
  /** Shown once. Null when no token was asked for. */
  token: string | null;
  verification: "owner-login" | "sent" | "not-sent";
  verificationError?: string;
};

async function resolveOperator(sb: Sb, ownerId: string, raw: unknown): Promise<StoreResult<string | null>> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, status: 400, error: "operator must be an actor id or email." };
  const email = normalizeEmail(raw);
  let query = sb.from("tracker_actors").select("id, kind").eq("owner_id", ownerId).is("revoked_at", null);
  query = email ? query.eq("email", email) : query.eq("id", raw);
  const { data } = await query.limit(1).maybeSingle();
  const row = data as { id: string; kind: string } | null;
  if (!row) return { ok: false, status: 400, error: `No actor "${raw}" on this account to act as operator.` };
  if (row.kind !== "human") return { ok: false, status: 400, error: "An operator must be a human actor." };
  return { ok: true, value: row.id };
}

export async function createActor(sb: Sb, ownerId: string, input: CreateActorInput): Promise<StoreResult<CreatedActor>> {
  const email = normalizeEmail(input.email);
  if (!email) return { ok: false, status: 400, error: "A valid email is required." };
  const kind = parseDeclaredKind(input.kind);
  if (!kind) return { ok: false, status: 400, error: "kind must be human or agent." };
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
  const visibility = input.visibility === "public" ? "public" : "private";

  const operator = await resolveOperator(sb, ownerId, input.operator);
  if (!operator.ok) return operator;
  if (operator.value && kind !== "agent") {
    return { ok: false, status: 400, error: "Only an agent has an operator." };
  }

  const { data: dupe } = await sb
    .from("tracker_actors")
    .select("id")
    .eq("owner_id", ownerId)
    .eq("email", email)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  if (dupe) return { ok: false, status: 409, error: `${email} is already an actor on this account.` };

  // The owner's own login address is proven by the login itself.
  const isOwnerLogin = (await ownerEmail(sb, ownerId)) === email;
  let verifyToken: string | null = null;
  if (isOwnerLogin) {
    const { data: taken } = await sb
      .from("tracker_actors")
      .select("id")
      .eq("email", email)
      .not("email_verified_at", "is", null)
      .is("revoked_at", null)
      .limit(1)
      .maybeSingle();
    if (taken) return { ok: false, status: 409, error: `${email} is already a verified actor on another account.` };
  } else {
    verifyToken = crypto.randomBytes(24).toString("base64url");
  }

  const { data: inserted, error } = await sb
    .from("tracker_actors")
    .insert({
      owner_id: ownerId,
      email,
      name,
      kind,
      operator_actor_id: operator.value,
      visibility,
      email_verified_at: isOwnerLogin ? new Date().toISOString() : null,
      verify_token_hash: verifyToken ? hashActorToken(`v_${verifyToken}`) : null,
    })
    .select("id")
    .single();
  if (error || !inserted) return { ok: false, status: 500, error: error?.message ?? "insert failed" };
  const actorId = (inserted as { id: string }).id;

  let token: string | null = null;
  if (input.tokenLabel !== undefined && input.tokenLabel !== null && input.tokenLabel !== false) {
    const minted = await mintToken(sb, ownerId, actorId, input.tokenLabel);
    if (!minted.ok) return minted;
    token = minted.value.token;
  }

  let verification: CreatedActor["verification"] = isOwnerLogin ? "owner-login" : "not-sent";
  let verificationError: string | undefined;
  if (verifyToken) {
    const sent = await sendActorVerifyEmail({
      to: email,
      kind,
      name,
      verifyUrl: `${env.siteUrl}/api/tracker/v1/actors/${actorId}/verify?t=${verifyToken}`,
    });
    if (sent.sent) verification = "sent";
    else verificationError = sent.error;
  }

  return {
    ok: true,
    value: {
      actor: { id: actorId, email, kind, email_verified: isOwnerLogin },
      token,
      verification,
      ...(verificationError ? { verificationError } : {}),
    },
  };
}

async function ownedActor(sb: Sb, ownerId: string, actorId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(actorId)) return null;
  const { data } = await sb
    .from("tracker_actors")
    .select("id, email, kind")
    .eq("id", actorId)
    .eq("owner_id", ownerId)
    .is("revoked_at", null)
    .maybeSingle();
  return data as { id: string; email: string; kind: DeclaredKind } | null;
}

export async function mintToken(
  sb: Sb,
  ownerId: string,
  actorId: string,
  label: unknown,
): Promise<StoreResult<{ id: string; token: string; prefix: string }>> {
  if (!(await ownedActor(sb, ownerId, actorId))) return { ok: false, status: 404, error: "No such actor." };
  const minted = mintActorToken();
  const { data, error } = await sb
    .from("tracker_actor_tokens")
    .insert({
      actor_id: actorId,
      prefix: minted.prefix,
      token_hash: minted.hash,
      label: typeof label === "string" ? label.trim().slice(0, 200) : "",
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "insert failed" };
  return { ok: true, value: { id: (data as { id: string }).id, token: minted.plaintext, prefix: minted.prefix } };
}

export async function revokeToken(sb: Sb, ownerId: string, actorId: string, tokenId: string): Promise<StoreResult<null>> {
  if (!(await ownedActor(sb, ownerId, actorId))) return { ok: false, status: 404, error: "No such actor." };
  const { data, error } = await sb
    .from("tracker_actor_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("actor_id", actorId)
    .is("revoked_at", null)
    .select("id");
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data?.length) return { ok: false, status: 404, error: "No such live token." };
  return { ok: true, value: null };
}

export async function revokeActor(sb: Sb, ownerId: string, actorId: string): Promise<StoreResult<null>> {
  if (!(await ownedActor(sb, ownerId, actorId))) return { ok: false, status: 404, error: "No such actor." };
  const now = new Date().toISOString();
  await sb.from("tracker_actor_tokens").update({ revoked_at: now }).eq("actor_id", actorId).is("revoked_at", null);
  const { error } = await sb.from("tracker_actors").update({ revoked_at: now }).eq("id", actorId);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, value: null };
}

export async function updateActor(
  sb: Sb,
  ownerId: string,
  actorId: string,
  patch: { name?: unknown; visibility?: unknown; operator?: unknown },
): Promise<StoreResult<null>> {
  const actor = await ownedActor(sb, ownerId, actorId);
  if (!actor) return { ok: false, status: 404, error: "No such actor." };
  const update: Record<string, unknown> = {};
  if (typeof patch.name === "string") update.name = patch.name.trim().slice(0, 120);
  if (patch.visibility === "public" || patch.visibility === "private") update.visibility = patch.visibility;
  if (patch.operator !== undefined) {
    if (actor.kind !== "agent" && patch.operator) return { ok: false, status: 400, error: "Only an agent has an operator." };
    const op = await resolveOperator(sb, ownerId, patch.operator);
    if (!op.ok) return op;
    update.operator_actor_id = op.value;
  }
  if (!Object.keys(update).length) return { ok: false, status: 400, error: "Nothing to update." };
  const { error } = await sb.from("tracker_actors").update(update).eq("id", actorId);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, value: null };
}

/** The link in the verification email. Public: the token is the proof. */
export async function verifyActorEmail(sb: Sb, actorId: string, token: string): Promise<StoreResult<{ email: string }>> {
  if (!/^[0-9a-f-]{36}$/i.test(actorId) || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    return { ok: false, status: 400, error: "Malformed link." };
  }
  const { data } = await sb
    .from("tracker_actors")
    .select("id, email, verify_token_hash, email_verified_at, revoked_at")
    .eq("id", actorId)
    .maybeSingle();
  const row = data as { email: string; verify_token_hash: string | null; email_verified_at: string | null; revoked_at: string | null } | null;
  if (!row || row.revoked_at) return { ok: false, status: 404, error: "This actor no longer exists." };
  if (row.email_verified_at) return { ok: true, value: { email: row.email } };
  const expected = row.verify_token_hash ?? "";
  const got = hashActorToken(`v_${token}`);
  if (expected.length !== got.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got))) {
    return { ok: false, status: 400, error: "This link is not valid." };
  }
  const { error } = await sb
    .from("tracker_actors")
    .update({ email_verified_at: new Date().toISOString(), verify_token_hash: null })
    .eq("id", actorId);
  // The partial unique index refuses a second verified claim on an address.
  if (error) return { ok: false, status: 409, error: `${row.email} is already a verified actor on another account.` };
  return { ok: true, value: { email: row.email } };
}

/** First UTC day a range covers, for the daily actor rollup. */
export function rangeSinceDay(range: TrackerRange): string {
  if (range.days === 0) return "1970-01-01";
  if (range.days) return daysAgo(range.days - 1);
  return daysAgo(0);
}

export type DeclaredSummary = {
  definition: string;
  totals: DeclaredTotals;
  /**
   * Named actors on this site: only the viewer's own, or actors their owners
   * made public. Everyone else is in the totals and nowhere else.
   */
  actors: { name: string; email: string; kind: DeclaredKind; events: number; pageviews: number; contradictions: number; mine: boolean }[];
};

export async function declaredSummary(
  sb: Sb,
  viewerId: string,
  projectId: string,
  range: TrackerRange,
  definition: string,
): Promise<DeclaredSummary | null> {
  const since = rangeSinceDay(range);
  const { data: totals, error } = await sb.rpc("tracker_declared_totals", { p_project: projectId, p_since: since });
  // Before the migration is applied the RPC is missing; say nothing rather
  // than print zeros that read as "nobody declared".
  if (error) return null;

  const { data: rows } = await sb
    .from("tracker_actor_daily_stats")
    .select("actor_id, events, pageviews, contradictions, actor:tracker_actors!inner(name, email, kind, owner_id, visibility)")
    .eq("project_id", projectId)
    .gte("day", since);
  const byActor = new Map<string, DeclaredSummary["actors"][number]>();
  for (const r of (rows ?? []) as Record<string, unknown>[]) {
    const a = r.actor as { name: string; email: string; kind: string; owner_id: string; visibility: string } | null;
    if (!a) continue;
    const mine = a.owner_id === viewerId;
    if (!mine && a.visibility !== "public") continue;
    const key = r.actor_id as string;
    const cur = byActor.get(key) ?? {
      name: a.name,
      email: a.email,
      kind: (a.kind === "agent" ? "agent" : "human") as DeclaredKind,
      events: 0,
      pageviews: 0,
      contradictions: 0,
      mine,
    };
    cur.events += Number(r.events) || 0;
    cur.pageviews += Number(r.pageviews) || 0;
    cur.contradictions += Number(r.contradictions) || 0;
    byActor.set(key, cur);
  }

  return {
    definition,
    totals: toDeclaredTotals(totals),
    actors: [...byActor.values()].sort((x, y) => y.events - x.events),
  };
}
