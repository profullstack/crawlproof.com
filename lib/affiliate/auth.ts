// Who is asking. Three credentials reach the affiliate routes:
//   Authorization: Bearer oa_…   an affiliate's ledger token (outside party or ours)
//   Authorization: Bearer crp_…  a CrawlProof API token → that user's membership
//   the session cookie           a signed-in user → their membership
// The first is what the spec promises; the other two let our own users and
// their agents use the same routes without minting a second credential.

import type { NextRequest } from "next/server";
import { authenticateBearer } from "../sp/apiAuth";
import { createClient } from "../supabase/server";
import { serviceClient } from "../supabase/service";
import { isAffiliateTokenShape } from "./tokens";
import { ensureMembershipForUser, membershipByToken, membershipForUser, type Membership } from "./memberships";

export type Caller =
  | { ok: true; membership: Membership; via: "token" | "api" | "session"; user: { id: string; email: string | null } | null }
  | { ok: false; status: number; error: string };

async function userFromRequest(req: NextRequest): Promise<{ id: string; email: string | null } | { status: number; error: string }> {
  const header = req.headers.get("authorization") ?? "";
  if (/^bearer\s+/i.test(header)) {
    const auth = await authenticateBearer(req);
    if (!auth.ok) return { status: auth.status, error: auth.error };
    const { data } = await serviceClient().from("profiles").select("email").eq("id", auth.userId).maybeSingle();
    return { id: auth.userId, email: data?.email ?? null };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: 401, error: "Sign in, send an API token, or send your affiliate token." };
  return { id: user.id, email: user.email ?? null };
}

/** The signed-in user or API-token user, without a membership. */
export async function resolveUser(req: NextRequest): Promise<{ ok: true; user: { id: string; email: string | null } } | { ok: false; status: number; error: string }> {
  const u = await userFromRequest(req);
  if ("status" in u) return { ok: false, status: u.status, error: u.error };
  return { ok: true, user: u };
}

/** The caller's membership in our program, created on first use for our own users. */
export async function resolveCaller(req: NextRequest, opts: { create?: boolean } = { create: true }): Promise<Caller> {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.replace(/^bearer\s+/i, "").trim();
  if (bearer && isAffiliateTokenShape(bearer)) {
    const membership = await membershipByToken(bearer);
    if (!membership) return { ok: false, status: 401, error: "Unknown affiliate token." };
    return { ok: true, membership, via: "token", user: null };
  }
  const u = await userFromRequest(req);
  if ("status" in u) return { ok: false, status: u.status, error: u.error };
  const m = opts.create === false
    ? await membershipForUser(u.id)
    : await ensureMembershipForUser({ id: u.id, email: u.email });
  if (!m) return { ok: false, status: 404, error: "No affiliate membership yet." };
  return { ok: true, membership: m, via: bearer ? "api" : "session", user: u };
}
