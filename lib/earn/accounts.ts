// Who is asking, and which account on the rail is theirs.
//
// The rule is deliberately simple: a session cookie is a person, a bearer
// token is an agent. Both are first-class parties and either can pay either.
// A token is issued to a user, so one owner can run several agents with
// separate balances by minting several tokens — which is the point, since an
// agent's balance is the thing it spends.

import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { PROBATION_DAYS, probationCleared } from "./rates";

export type PartyKind = "human" | "agent";

export type EarnAccount = {
  id: string;
  kind: PartyKind;
  ownerId: string | null;
  agentTokenId: string | null;
  label: string | null;
  payoutAddress: string | null;
  payoutEmail: string | null;
  status: "probation" | "active" | "suspended";
  balanceMicros: number;
  lifetimeEarnedMicros: number;
  createdAt: string;
};

type Row = {
  id: string;
  kind: PartyKind;
  owner_id: string | null;
  agent_token_id: string | null;
  label: string | null;
  payout_address: string | null;
  payout_email: string | null;
  status: "probation" | "active" | "suspended";
  balance_micros: number | string;
  lifetime_earned_micros: number | string;
  created_at: string;
};

// bigint columns come back as strings over PostgREST once they are large
// enough, and as numbers when they are small. Read both the same way.
const big = (v: number | string | null | undefined): number => Number(v ?? 0) || 0;

const toAccount = (row: Row): EarnAccount => ({
  id: row.id,
  kind: row.kind,
  ownerId: row.owner_id,
  agentTokenId: row.agent_token_id,
  label: row.label,
  payoutAddress: row.payout_address,
  payoutEmail: row.payout_email,
  status: row.status,
  balanceMicros: big(row.balance_micros),
  lifetimeEarnedMicros: big(row.lifetime_earned_micros),
  createdAt: row.created_at,
});

const COLUMNS =
  "id, kind, owner_id, agent_token_id, label, payout_address, payout_email, status, balance_micros, lifetime_earned_micros, created_at";

/**
 * Probation ends by the calendar, so nothing has to run on a schedule to end
 * it. Checked whenever the account is read, and written back once so the
 * status column is true for anything that queries it directly.
 */
async function activateIfDue(sb: SupabaseClient, account: EarnAccount): Promise<EarnAccount> {
  if (account.status !== "probation") return account;
  if (!probationCleared(account.createdAt)) return account;
  const { data } = await sb
    .from("earn_accounts")
    .update({ status: "active", activated_at: new Date().toISOString() })
    .eq("id", account.id)
    .eq("status", "probation")
    .select(COLUMNS)
    .maybeSingle();
  return data ? toAccount(data as Row) : { ...account, status: "active" };
}

/** The account for a person, made on first sight. */
export async function humanAccount(userId: string, email?: string | null): Promise<EarnAccount> {
  const sb = serviceClient();
  const { data: existing } = await sb
    .from("earn_accounts")
    .select(COLUMNS)
    .eq("owner_id", userId)
    .eq("kind", "human")
    .maybeSingle();
  if (existing) return activateIfDue(sb, toAccount(existing as Row));

  const { data, error } = await sb
    .from("earn_accounts")
    .insert({ kind: "human", owner_id: userId, payout_email: email ?? null })
    .select(COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toAccount(data as Row);
}

/** The account for an agent, keyed on the token it presented. */
export async function agentAccount(tokenId: string, label?: string | null): Promise<EarnAccount> {
  const sb = serviceClient();
  const { data: existing } = await sb
    .from("earn_accounts")
    .select(COLUMNS)
    .eq("agent_token_id", tokenId)
    .maybeSingle();
  if (existing) return activateIfDue(sb, toAccount(existing as Row));

  const { data, error } = await sb
    .from("earn_accounts")
    .insert({ kind: "agent", agent_token_id: tokenId, label: label ?? null })
    .select(COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toAccount(data as Row);
}

export async function accountById(id: string): Promise<EarnAccount | null> {
  const { data } = await serviceClient()
    .from("earn_accounts")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();
  return data ? toAccount(data as Row) : null;
}

export type PartyOk = { ok: true; account: EarnAccount };
export type PartyErr = { ok: false; status: number; error: string };

/**
 * The party behind a request, whichever way they authenticated.
 *
 * Bearer first: a caller that sent a token meant to act as its agent, even if
 * it also happens to carry a session cookie from some other tab.
 */
export async function resolveParty(req: NextRequest): Promise<PartyOk | PartyErr> {
  const header = req.headers.get("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    const auth = await authenticateBearer(req);
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
    return { ok: true, account: await agentAccount(auth.tokenId) };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      status: 401,
      error: "Sign in, or send an API token, to use the earn rail.",
    };
  }
  return { ok: true, account: await humanAccount(user.id, user.email ?? null) };
}

/** Where earnings go. One address per account, and never two accounts on one. */
export async function setPayoutAddress(
  accountId: string,
  address: string,
): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
  const wanted = String(address ?? "").trim();
  if (wanted && !/^0x[0-9a-fA-F]{40}$/.test(wanted)) {
    return { ok: false, error: "That is not a wallet address. It starts with 0x and is 42 characters." };
  }
  const { error } = await serviceClient()
    .from("earn_accounts")
    .update({ payout_address: wanted || null })
    .eq("id", accountId);
  if (error) {
    // The unique index on lower(payout_address) is the whole anti-sockpuppet
    // control, so say plainly what happened rather than leaking a constraint.
    if (/duplicate key|unique/i.test(error.message)) {
      return { ok: false, error: "That address is already claimed by another account." };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true, address: wanted };
}

export const probationDays = PROBATION_DAYS;
