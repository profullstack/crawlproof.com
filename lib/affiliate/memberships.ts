// Memberships in the program we run: join, look up, and the ledger an
// affiliate reads. Every write uses the service client and every read is
// scoped by the caller's own membership, because the route is public.

import crypto from "node:crypto";
import { serviceClient } from "../supabase/service";
import { env } from "../env";
import { hashAffiliateToken, mintAffiliateToken } from "./tokens";
import { fetchProfile } from "./client";
import { PAYS, PROGRAM_ID, WINDOW_DAYS, CURRENCY } from "./program";
import { codeFromProfile, isAffiliateCode, slugify, type JoinRequest, type Pays } from "./spec";

export type Membership = {
  id: string;
  program: string;
  ownerId: string | null;
  profileUrl: string | null;
  kind: "person" | "agent" | "organization";
  displayName: string | null;
  email: string | null;
  payAddress: string | null;
  webhookUrl: string | null;
  code: string;
  tokenPrefix: string;
  status: "active" | "pending" | "refused" | "ended";
  terms: Pays[];
  createdAt: string;
};

const COLUMNS =
  "id, program, owner_id, profile_url, kind, display_name, email, pay_address, webhook_url, code, token_prefix, status, terms, created_at";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMembership(r: any): Membership {
  return {
    id: r.id,
    program: r.program,
    ownerId: r.owner_id ?? null,
    profileUrl: r.profile_url ?? null,
    kind: r.kind ?? "person",
    displayName: r.display_name ?? null,
    email: r.email ?? null,
    payAddress: r.pay_address ?? null,
    webhookUrl: r.webhook_url ?? null,
    code: r.code,
    tokenPrefix: r.token_prefix,
    status: r.status,
    terms: Array.isArray(r.terms) ? (r.terms as Pays[]) : PAYS,
    createdAt: r.created_at,
  };
}

export function linkForMembership(m: Pick<Membership, "code">): string {
  return `${env.siteUrl.replace(/\/$/, "")}/?oa=${encodeURIComponent(m.code)}`;
}

export function profileUrlForMembership(m: Pick<Membership, "code">): string {
  return `${env.siteUrl.replace(/\/$/, "")}/affiliate/u/${encodeURIComponent(m.code)}/openprofile.md`;
}

export async function membershipById(id: string): Promise<Membership | null> {
  const { data } = await serviceClient().from("affiliate_memberships").select(COLUMNS).eq("id", id).maybeSingle();
  return data ? toMembership(data) : null;
}

export async function membershipByCode(code: string): Promise<Membership | null> {
  if (!isAffiliateCode(code)) return null;
  const { data } = await serviceClient()
    .from("affiliate_memberships")
    .select(COLUMNS)
    .eq("program", PROGRAM_ID)
    .ilike("code", code)
    .maybeSingle();
  return data ? toMembership(data) : null;
}

export async function membershipByToken(plaintext: string): Promise<Membership | null> {
  const { data } = await serviceClient()
    .from("affiliate_memberships")
    .select(COLUMNS)
    .eq("token_hash", hashAffiliateToken(plaintext))
    .maybeSingle();
  return data ? toMembership(data) : null;
}

export async function membershipForUser(userId: string): Promise<Membership | null> {
  const { data } = await serviceClient()
    .from("affiliate_memberships")
    .select(COLUMNS)
    .eq("program", PROGRAM_ID)
    .eq("owner_id", userId)
    .maybeSingle();
  return data ? toMembership(data) : null;
}

/** A code nobody else has: the wanted one, else it with a short suffix. */
async function freeCode(wanted: string): Promise<string> {
  const base = isAffiliateCode(wanted) ? wanted : "partner";
  const svc = serviceClient();
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 26)}-${crypto.randomBytes(2).toString("hex")}`;
    const { data } = await svc
      .from("affiliate_memberships")
      .select("id")
      .eq("program", PROGRAM_ID)
      .ilike("code", candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  return `p-${crypto.randomBytes(6).toString("hex")}`;
}

export type JoinOutcome =
  | { ok: true; membership: Membership; token: string | null; existing: boolean }
  | { ok: false; status: number; error: string };

/**
 * Join our program. A second join by the same profile (or the same user)
 * answers the existing membership without a new token (spec, "Joining").
 * ownerId links a CrawlProof user to the membership; outside affiliates have
 * only a profile.
 */
export async function joinOurProgram(
  request: Partial<JoinRequest> & { profile?: string },
  opts: { ownerId?: string | null; email?: string | null; displayName?: string | null } = {},
): Promise<JoinOutcome> {
  const svc = serviceClient();
  const ownerId = opts.ownerId ?? null;

  if (ownerId) {
    const mine = await membershipForUser(ownerId);
    if (mine) return { ok: true, membership: mine, token: null, existing: true };
  }

  let profileUrl: string | null = request.profile ?? null;
  let kind: Membership["kind"] = "person";
  let displayName = opts.displayName ?? null;
  let email = opts.email ?? null;
  let pay = request.pay ?? null;
  let wantedCode = request.code ?? "";

  if (profileUrl) {
    const { data: twin } = await svc
      .from("affiliate_memberships")
      .select(COLUMNS)
      .eq("program", PROGRAM_ID)
      .ilike("profile_url", profileUrl)
      .maybeSingle();
    if (twin) return { ok: true, membership: toMembership(twin), token: null, existing: true };

    const profile = await fetchProfile(profileUrl);
    if (!profile.ok) {
      return { ok: false, status: 422, error: `Could not read the profile at ${profileUrl}: ${profile.error}` };
    }
    kind = profile.facts.kind;
    displayName = displayName ?? profile.facts.name ?? null;
    email = email ?? profile.facts.email ?? null;
    pay = pay ?? profile.facts.pay ?? null;
    if (!wantedCode) wantedCode = codeFromProfile(profileUrl, profile.facts);
  } else if (!ownerId) {
    return { ok: false, status: 400, error: "profile is required." };
  }

  if (!wantedCode) {
    const local = (email ?? "").split("@")[0] ?? "";
    wantedCode = slugify(displayName ?? local);
  }
  const code = await freeCode(wantedCode);
  const minted = mintAffiliateToken();

  const { data, error } = await svc
    .from("affiliate_memberships")
    .insert({
      program: PROGRAM_ID,
      owner_id: ownerId,
      profile_url: profileUrl,
      kind,
      display_name: displayName,
      email,
      pay_address: pay,
      webhook_url: request.webhook ?? null,
      code,
      token_prefix: minted.prefix,
      token_hash: minted.hash,
      status: "active",
      terms: PAYS,
    })
    .select(COLUMNS)
    .single();
  if (error || !data) {
    if (/duplicate key|unique/i.test(error?.message ?? "")) {
      // A race on the same profile or owner: answer the row that won.
      if (ownerId) {
        const mine = await membershipForUser(ownerId);
        if (mine) return { ok: true, membership: mine, token: null, existing: true };
      }
      return { ok: false, status: 409, error: "That code was taken a moment ago. Try again." };
    }
    return { ok: false, status: 500, error: error?.message ?? "Could not create the membership." };
  }
  return { ok: true, membership: toMembership(data), token: minted.plaintext, existing: false };
}

/** Find-or-create the membership for a CrawlProof user. */
export async function ensureMembershipForUser(user: {
  id: string;
  email?: string | null;
  displayName?: string | null;
}): Promise<Membership | null> {
  const found = await membershipForUser(user.id);
  if (found) return found;
  const joined = await joinOurProgram({}, { ownerId: user.id, email: user.email ?? null, displayName: user.displayName ?? null });
  return joined.ok ? joined.membership : null;
}

export async function setPayAddress(membershipId: string, address: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await serviceClient()
    .from("affiliate_memberships")
    .update({ pay_address: address, updated_at: new Date().toISOString() })
    .eq("id", membershipId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function setWebhook(membershipId: string, webhook: string | null): Promise<void> {
  await serviceClient()
    .from("affiliate_memberships")
    .update({ webhook_url: webhook, updated_at: new Date().toISOString() })
    .eq("id", membershipId);
}

/** Rotate the token: the old one stops working the moment this returns. */
export async function rotateToken(membershipId: string): Promise<string> {
  const minted = mintAffiliateToken();
  const { error } = await serviceClient()
    .from("affiliate_memberships")
    .update({ token_prefix: minted.prefix, token_hash: minted.hash, updated_at: new Date().toISOString() })
    .eq("id", membershipId);
  if (error) throw new Error(error.message);
  return minted.plaintext;
}

// ─── The ledger ─────────────────────────────────────────────────────────────

export type LedgerConversion = {
  id: string;
  at: string;
  event: string;
  order: string;
  amount: number;
  commission: number;
  status: string;
  held_until?: string;
  reason?: string;
  recurring?: { n: number; of: number | null };
  updated: string;
};

export type Ledger = {
  membership: string;
  program: string;
  currency: string;
  code: string;
  link: string;
  status: string;
  pays: Pays[];
  clicks: { total: number; window: number };
  balance: { pending: number; approved: number; paid: number };
  conversions: LedgerConversion[];
  payouts: Array<{ id: string; at: string; amount: number; method: string; status: string; tx: string | null }>;
};

const dollars = (cents: number) => Math.round(cents) / 100;

export async function ledgerFor(m: Membership, since?: Date | null): Promise<Ledger> {
  const svc = serviceClient();
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

  const [clicksAll, clicksWindow, convRows, sums, payoutRows] = await Promise.all([
    svc.from("affiliate_clicks").select("id", { count: "exact", head: true }).eq("membership_id", m.id),
    svc.from("affiliate_clicks").select("id", { count: "exact", head: true }).eq("membership_id", m.id).gte("at", windowStart),
    (() => {
      let q = svc
        .from("affiliate_conversions")
        .select("id, created_at, updated_at, event, order_ref, amount_cents, commission_cents, status, held_until, reason, recurring_n, recurring_of")
        .eq("membership_id", m.id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (since) q = q.or(`created_at.gte.${since.toISOString()},updated_at.gte.${since.toISOString()}`);
      return q;
    })(),
    svc.from("affiliate_conversions").select("status, commission_cents").eq("membership_id", m.id),
    svc
      .from("affiliate_payouts")
      .select("id, created_at, settled_at, amount_cents, method, status, tx_hash")
      .eq("membership_id", m.id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const balance = { pending: 0, approved: 0, paid: 0 };
  for (const r of (sums.data ?? []) as Array<{ status: string; commission_cents: number }>) {
    if (r.status === "pending") balance.pending += r.commission_cents;
    else if (r.status === "approved") balance.approved += r.commission_cents;
    else if (r.status === "paid") balance.paid += r.commission_cents;
  }

  return {
    membership: m.id,
    program: m.program,
    currency: CURRENCY,
    code: m.code,
    link: linkForMembership(m),
    status: m.status,
    pays: m.terms,
    clicks: { total: clicksAll.count ?? 0, window: clicksWindow.count ?? 0 },
    balance: { pending: dollars(balance.pending), approved: dollars(balance.approved), paid: dollars(balance.paid) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conversions: ((convRows.data ?? []) as any[]).map((r) => ({
      id: r.id,
      at: r.created_at,
      event: r.event,
      order: r.order_ref,
      amount: dollars(r.amount_cents),
      commission: dollars(r.commission_cents),
      status: r.status,
      ...(r.held_until ? { held_until: r.held_until } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.recurring_n ? { recurring: { n: r.recurring_n, of: r.recurring_of ?? null } } : {}),
      updated: r.updated_at,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payouts: ((payoutRows.data ?? []) as any[]).map((r) => ({
      id: r.id,
      at: r.settled_at ?? r.created_at,
      amount: dollars(r.amount_cents),
      method: r.method,
      status: r.status,
      tx: r.tx_hash ?? null,
    })),
  };
}
