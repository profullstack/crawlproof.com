"use server";

// Server actions behind /dashboard/affiliate. Every one resolves the user
// from the session first; nothing here trusts an id from the client.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { ensureMembershipForUser, rotateToken, setPayAddress, setWebhook } from "@/lib/affiliate/memberships";
import { requestPayout } from "@/lib/affiliate/payouts";
import { addOrRefreshProgram, joinExternal, syncJoin } from "@/lib/affiliate/directory";
import { isAffiliateCode, isPayAddress } from "@/lib/affiliate/spec";

type Result<T extends Record<string, unknown> = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string };

async function me(): Promise<{ id: string; email: string | null } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? { id: user.id, email: user.email ?? null } : null;
}

const PAGE = "/dashboard/affiliate";

export async function savePayAddress(input: { pay: string }): Promise<Result> {
  const user = await me();
  if (!user) return { ok: false, error: "Sign in first." };
  const pay = input.pay.trim();
  if (pay && !isPayAddress(pay)) return { ok: false, error: "That is not a wallet address. It starts with 0x and is 42 characters." };
  const m = await ensureMembershipForUser(user);
  if (!m) return { ok: false, error: "Could not open your membership." };
  const out = await setPayAddress(m.id, pay || null);
  if (!out.ok) return out;
  revalidatePath(PAGE);
  return { ok: true };
}

export async function saveWebhook(input: { webhook: string }): Promise<Result> {
  const user = await me();
  if (!user) return { ok: false, error: "Sign in first." };
  const w = input.webhook.trim();
  if (w && !/^https:\/\//.test(w)) return { ok: false, error: "A webhook is an https URL." };
  const m = await ensureMembershipForUser(user);
  if (!m) return { ok: false, error: "Could not open your membership." };
  await setWebhook(m.id, w || null);
  revalidatePath(PAGE);
  return { ok: true };
}

export async function rotateAffiliateToken(): Promise<Result<{ token: string }>> {
  const user = await me();
  if (!user) return { ok: false, error: "Sign in first." };
  const m = await ensureMembershipForUser(user);
  if (!m) return { ok: false, error: "Could not open your membership." };
  const token = await rotateToken(m.id);
  revalidatePath(PAGE);
  return { ok: true, token };
}

export async function requestAffiliatePayout(): Promise<Result<{ amount: number; tx: string | null }>> {
  const user = await me();
  if (!user) return { ok: false, error: "Sign in first." };
  const m = await ensureMembershipForUser(user);
  if (!m) return { ok: false, error: "Could not open your membership." };
  const out = await requestPayout(m);
  if (!out.ok) return { ok: false, error: out.error };
  revalidatePath(PAGE);
  return { ok: true, amount: out.amountCents / 100, tx: out.txHash };
}

export async function addProgram(input: { url: string }): Promise<Result<{ origin: string; programs: number; warnings: string[] }>> {
  const user = await me();
  if (!user) return { ok: false, error: "Sign in first." };
  const url = input.url.trim();
  if (!url) return { ok: false, error: "Paste the merchant's URL." };
  const out = await addOrRefreshProgram(url, user.id);
  if (!out.ok) return { ok: false, error: out.error };
  revalidatePath(PAGE);
  revalidatePath("/affiliate/programs");
  return { ok: true, origin: out.row.origin, programs: out.row.descriptor?.programs.length ?? 0, warnings: out.warnings };
}

export async function joinProgramAction(input: { origin: string; program?: string; code?: string }): Promise<Result<{ status: string; link: string | null }>> {
  const user = await me();
  if (!user) return { ok: false, error: "Sign in first." };
  if (input.code && !isAffiliateCode(input.code)) return { ok: false, error: "A code is 3 to 32 lower-case letters, digits or dashes." };
  const out = await joinExternal(user, { origin: input.origin, programId: input.program, code: input.code });
  if (!out.ok) return { ok: false, error: out.error };
  revalidatePath(PAGE);
  return { ok: true, status: out.join.status, link: out.join.link };
}

export async function syncJoinAction(input: { id: string }): Promise<Result> {
  const user = await me();
  if (!user) return { ok: false, error: "Sign in first." };
  const out = await syncJoin(input.id, user.id);
  if (!out.ok) return { ok: false, error: out.error };
  revalidatePath(PAGE);
  return { ok: true };
}
