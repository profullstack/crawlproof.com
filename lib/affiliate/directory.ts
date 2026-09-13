// The affiliate side, persisted: a directory of merchants whose descriptors
// we have read, and our users' joins into their programs. We join with the
// user's own profile (served at /affiliate/u/<code>/openprofile.md) and hold
// the merchant's token for the user, readable only through the owner.

import { serviceClient } from "../supabase/service";
import { env } from "../env";
import { discoverDescriptor, joinProgram, readLedger } from "./client";
import { ensureMembershipForUser, profileUrlForMembership } from "./memberships";
import { parseDescriptor, type Descriptor, type Program } from "./spec";

type Svc = ReturnType<typeof serviceClient>;

export type DirectoryRow = {
  id: string;
  origin: string;
  descriptor: Descriptor | null;
  verified: boolean;
  fetchedAt: string | null;
  error: string | null;
};

export type DirectoryProgram = {
  origin: string;
  merchant: Descriptor["merchant"];
  program: Program;
  verified: boolean;
  fetchedAt: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRow(r: any): DirectoryRow {
  const parsed = r.descriptor ? parseDescriptor(r.descriptor) : null;
  return {
    id: r.id,
    origin: r.origin,
    descriptor: parsed?.ok ? parsed.descriptor : null,
    verified: !!r.verified,
    fetchedAt: r.fetched_at ?? null,
    error: r.error ?? null,
  };
}

export async function listDirectory(): Promise<DirectoryProgram[]> {
  const { data } = await serviceClient()
    .from("affiliate_programs")
    .select("id, origin, descriptor, verified, fetched_at, error")
    .not("descriptor", "is", null)
    .order("fetched_at", { ascending: false })
    .limit(500);
  const out: DirectoryProgram[] = [];
  for (const raw of data ?? []) {
    const row = toRow(raw);
    if (!row.descriptor) continue;
    for (const program of row.descriptor.programs) {
      if (program.status === "closed") continue;
      out.push({ origin: row.origin, merchant: row.descriptor.merchant, program, verified: row.verified, fetchedAt: row.fetchedAt });
    }
  }
  // Verified above claimed (spec, "Directories" rule 6), then newest read first.
  return out.sort((a, b) => Number(b.verified) - Number(a.verified));
}

export async function directoryRow(origin: string): Promise<DirectoryRow | null> {
  const { data } = await serviceClient()
    .from("affiliate_programs")
    .select("id, origin, descriptor, verified, fetched_at, error")
    .ilike("origin", origin)
    .maybeSingle();
  return data ? toRow(data) : null;
}

/** Read a merchant and keep what was found. A failed read keeps the last good descriptor and records the error. */
export async function addOrRefreshProgram(input: string, addedBy: string | null): Promise<{ ok: true; row: DirectoryRow; warnings: string[] } | { ok: false; error: string }> {
  const found = await discoverDescriptor(input);
  const svc = serviceClient();
  const now = new Date().toISOString();
  if (!found.ok) {
    let origin: string | null = null;
    try {
      origin = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`).origin;
    } catch {
      /* not a URL */
    }
    if (origin) {
      await svc
        .from("affiliate_programs")
        .update({ error: found.error, updated_at: now })
        .ilike("origin", origin);
    }
    return { ok: false, error: found.error };
  }
  // The unique index is on lower(origin), which a PostgREST upsert cannot
  // name, so: update the row that exists, else insert.
  const existing = await directoryRow(found.origin);
  const patch = { descriptor: found.raw, verified: found.verified, fetched_at: now, error: null, updated_at: now };
  const { error } = existing
    ? await svc.from("affiliate_programs").update(patch).eq("id", existing.id)
    : await svc.from("affiliate_programs").insert({ origin: found.origin, added_by: addedBy, ...patch });
  if (error) return { ok: false, error: error.message };
  const row = await directoryRow(found.origin);
  if (!row) return { ok: false, error: "Could not store the program." };
  return { ok: true, row, warnings: found.warnings };
}

/** Re-read every merchant not read in the last day (spec, "Directories" rule 1). */
export async function refreshStale(svc: Svc, now = new Date()): Promise<{ refreshed: number; failed: number }> {
  const { data } = await svc
    .from("affiliate_programs")
    .select("origin")
    .or(`fetched_at.is.null,fetched_at.lt.${new Date(now.getTime() - 86_400_000).toISOString()}`)
    .limit(100);
  let refreshed = 0;
  let failed = 0;
  for (const r of (data ?? []) as Array<{ origin: string }>) {
    const out = await addOrRefreshProgram(r.origin, null);
    out.ok ? refreshed++ : failed++;
  }
  return { refreshed, failed };
}

// ─── Joins ──────────────────────────────────────────────────────────────────

export type Join = {
  id: string;
  ownerId: string;
  origin: string;
  programId: string;
  membershipRef: string | null;
  code: string | null;
  link: string | null;
  ledgerUrl: string | null;
  status: "active" | "pending" | "refused" | "ended";
  terms: unknown;
  ledger: Record<string, unknown> | null;
  events: unknown[];
  syncedAt: string | null;
  error: string | null;
  createdAt: string;
  hasToken: boolean;
};

const JOIN_COLUMNS = "id, owner_id, origin, program_id, membership_ref, code, link, ledger_url, status, terms, ledger, events, synced_at, error, created_at, token";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toJoin(r: any): Join {
  return {
    id: r.id,
    ownerId: r.owner_id,
    origin: r.origin,
    programId: r.program_id,
    membershipRef: r.membership_ref ?? null,
    code: r.code ?? null,
    link: r.link ?? null,
    ledgerUrl: r.ledger_url ?? null,
    status: r.status,
    terms: r.terms ?? null,
    ledger: r.ledger ?? null,
    events: Array.isArray(r.events) ? r.events : [],
    syncedAt: r.synced_at ?? null,
    error: r.error ?? null,
    createdAt: r.created_at,
    hasToken: !!r.token,
  };
}

export async function listJoins(ownerId: string): Promise<Join[]> {
  const { data } = await serviceClient()
    .from("affiliate_joins")
    .select(JOIN_COLUMNS)
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []).map(toJoin);
}

export async function joinById(id: string, ownerId: string): Promise<Join | null> {
  const { data } = await serviceClient().from("affiliate_joins").select(JOIN_COLUMNS).eq("id", id).eq("owner_id", ownerId).maybeSingle();
  return data ? toJoin(data) : null;
}

export type JoinExternalOutcome = { ok: true; join: Join; existing: boolean } | { ok: false; error: string };

/**
 * Join another merchant's program on a user's behalf: with the user's own
 * profile, pay address and a webhook that lands back here.
 */
export async function joinExternal(
  user: { id: string; email?: string | null; displayName?: string | null },
  input: { origin: string; programId?: string; code?: string },
): Promise<JoinExternalOutcome> {
  const svc = serviceClient();
  let row = await directoryRow(input.origin);
  if (!row?.descriptor) {
    const added = await addOrRefreshProgram(input.origin, user.id);
    if (!added.ok) return { ok: false, error: added.error };
    row = added.row;
  }
  if (!row.descriptor) return { ok: false, error: "That merchant's descriptor could not be read." };
  const program = input.programId
    ? row.descriptor.programs.find((p) => p.id === input.programId)
    : row.descriptor.programs.find((p) => p.status === "active") ?? row.descriptor.programs[0];
  if (!program) return { ok: false, error: input.programId ? `No program ${input.programId} at ${row.origin}.` : `No program at ${row.origin}.` };

  const { data: twin } = await svc
    .from("affiliate_joins")
    .select(JOIN_COLUMNS)
    .eq("owner_id", user.id)
    .ilike("origin", row.origin)
    .eq("program_id", program.id)
    .maybeSingle();
  if (twin && twin.status !== "refused" && twin.status !== "ended") return { ok: true, join: toJoin(twin), existing: true };

  const mine = await ensureMembershipForUser(user);
  if (!mine) return { ok: false, error: "Could not create your CrawlProof affiliate profile." };

  const { data: inserted, error: insErr } = await svc
    .from("affiliate_joins")
    .upsert(
      { owner_id: user.id, origin: row.origin, program_id: program.id, status: "pending", terms: program.pays, updated_at: new Date().toISOString() },
      { onConflict: "owner_id,origin,program_id", ignoreDuplicates: false },
    )
    .select(JOIN_COLUMNS)
    .single();
  if (insErr || !inserted) return { ok: false, error: insErr?.message ?? "Could not start the join." };

  const site = env.siteUrl.replace(/\/$/, "");
  const answer = await joinProgram(program, {
    profile: profileUrlForMembership(mine),
    pay: mine.payAddress ?? undefined,
    webhook: `${site}/api/affiliate/v1/events/${inserted.id}`,
    code: input.code ?? mine.code,
  });
  const now = new Date().toISOString();
  if (!answer.ok) {
    await svc.from("affiliate_joins").update({ error: answer.error, updated_at: now }).eq("id", inserted.id);
    return { ok: false, error: answer.error };
  }
  const a = answer.answer;
  const { data: updated } = await svc
    .from("affiliate_joins")
    .update({
      membership_ref: a.membership,
      code: a.code ?? null,
      link: a.link ?? null,
      token: a.token ?? null,
      ledger_url: a.ledger ?? null,
      status: a.status,
      terms: a.pays ?? program.pays,
      error: null,
      updated_at: now,
    })
    .eq("id", inserted.id)
    .select(JOIN_COLUMNS)
    .single();
  const join = toJoin(updated ?? inserted);
  if (join.ledgerUrl && join.hasToken) await syncJoin(join.id, user.id);
  return { ok: true, join: (await joinById(join.id, user.id)) ?? join, existing: false };
}

/** Read the merchant's ledger for one join and keep it. */
export async function syncJoin(joinId: string, ownerId: string): Promise<{ ok: true; join: Join } | { ok: false; error: string }> {
  const svc = serviceClient();
  const { data } = await svc.from("affiliate_joins").select(JOIN_COLUMNS).eq("id", joinId).eq("owner_id", ownerId).maybeSingle();
  if (!data) return { ok: false, error: "No such join." };
  if (!data.ledger_url || !data.token) return { ok: false, error: "This program gave no ledger to read." };
  const read = await readLedger(data.ledger_url, data.token);
  const now = new Date().toISOString();
  if (!read.ok) {
    const patch: Record<string, unknown> = { error: read.error, updated_at: now };
    if (read.status === 401 || read.status === 403) patch.status = "ended";
    await svc.from("affiliate_joins").update(patch).eq("id", joinId);
    return { ok: false, error: read.error };
  }
  const status = typeof read.ledger.status === "string" && ["active", "pending", "refused", "ended"].includes(read.ledger.status) ? read.ledger.status : "active";
  await svc.from("affiliate_joins").update({ ledger: read.ledger, synced_at: now, status, error: null, updated_at: now }).eq("id", joinId);
  const join = await joinById(joinId, ownerId);
  return join ? { ok: true, join } : { ok: false, error: "Lost the join." };
}

/** An inbound webhook from a merchant we joined: keep the last 50 and re-sync. */
export async function recordInboundEvent(joinId: string, payload: unknown): Promise<boolean> {
  const svc = serviceClient();
  const { data } = await svc.from("affiliate_joins").select("id, owner_id, events").eq("id", joinId).maybeSingle();
  if (!data) return false;
  const events = Array.isArray(data.events) ? data.events : [];
  const next = [{ received: new Date().toISOString(), payload }, ...events].slice(0, 50);
  await svc.from("affiliate_joins").update({ events: next, updated_at: new Date().toISOString() }).eq("id", joinId);
  void syncJoin(joinId, data.owner_id).catch(() => {});
  return true;
}

/** Re-read every join's ledger not synced in the last day. */
export async function syncStaleJoins(svc: Svc, now = new Date()): Promise<{ synced: number; failed: number }> {
  const { data } = await svc
    .from("affiliate_joins")
    .select("id, owner_id")
    .not("token", "is", null)
    .not("ledger_url", "is", null)
    .in("status", ["active", "pending"])
    .or(`synced_at.is.null,synced_at.lt.${new Date(now.getTime() - 86_400_000).toISOString()}`)
    .limit(200);
  let synced = 0;
  let failed = 0;
  for (const j of (data ?? []) as Array<{ id: string; owner_id: string }>) {
    const out = await syncJoin(j.id, j.owner_id);
    out.ok ? synced++ : failed++;
  }
  return { synced, failed };
}
