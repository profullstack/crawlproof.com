// Bearer-token auth for /api/sp/v1/* endpoints.
//
// Verifies `Authorization: Bearer crp_…` against sp_api_token:
//   1. Hash the supplied token (SHA-256 + SP_TOKEN_PEPPER).
//   2. Look up the matching row in sp_api_token using the service-role
//      client (RLS scopes by auth.uid(), which we don't have here).
//   3. Reject if missing, revoked, or expired.
//   4. Update last_used_at fire-and-forget.
//
// Returns the owning user_id so the route can scope queries.

import type { NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { hashApiToken, isApiTokenShape } from "@/lib/sp/apiToken";

export type AuthOk = {
  ok: true;
  userId: string;
  tokenId: string;
};
export type AuthErr = { ok: false; status: number; error: string };

export async function authenticateBearer(
  req: NextRequest,
): Promise<AuthOk | AuthErr> {
  const header = req.headers.get("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, error: "Missing bearer token." };
  }
  return authenticateToken(header.slice("bearer ".length).trim());
}

// Verify a raw crp_ token (no header parsing). Shared by authenticateBearer and
// the MCP server's withMcpAuth verifier.
export async function authenticateToken(token: string): Promise<AuthOk | AuthErr> {
  if (!isApiTokenShape(token)) {
    return { ok: false, status: 401, error: "Malformed token." };
  }

  let tokenHash: string;
  try {
    tokenHash = hashApiToken(token);
  } catch (err) {
    // SP_TOKEN_PEPPER not configured — 500, not 401: this is our bug.
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Auth misconfigured.",
    };
  }

  const service = serviceClient();
  const { data: row, error } = await service
    .from("sp_api_token")
    .select("id, user_id, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) {
    return { ok: false, status: 500, error: error.message };
  }
  if (!row || row.revoked_at) {
    return { ok: false, status: 401, error: "Invalid or revoked token." };
  }

  // Fire-and-forget last_used_at update; don't await.
  void service
    .from("sp_api_token")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(() => undefined);

  return { ok: true, userId: row.user_id, tokenId: row.id };
}
