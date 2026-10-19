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
//
// Scoped tokens: a token minted read-only carries scope 'stats:read'. It is
// refused unless the route opts in with `{ allowScopes: [STATS_READ] }`, so a
// route that forgets to think about scopes stays full-access-only rather than
// quietly accepting a read-only token for a write.

import type { NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { hashApiToken, isApiTokenShape } from "@/lib/sp/apiToken";

/** The only scope there is: read the tracker numbers, nothing else. */
export const STATS_READ = "stats:read";
export type TokenScope = typeof STATS_READ;

export type AuthOk = {
  ok: true;
  userId: string;
  tokenId: string;
  /** null = full access. */
  scope: TokenScope | null;
};

export type AuthOptions = {
  /** Scoped tokens this route accepts on top of full-access ones. */
  allowScopes?: TokenScope[];
};
export type AuthErr = { ok: false; status: number; error: string };

export async function authenticateBearer(
  req: NextRequest,
  opts: AuthOptions = {},
): Promise<AuthOk | AuthErr> {
  const header = req.headers.get("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, error: "Missing bearer token." };
  }
  return authenticateToken(header.slice("bearer ".length).trim(), opts);
}

// Verify a raw crp_ token (no header parsing). Shared by authenticateBearer and
// the MCP server's withMcpAuth verifier.
export async function authenticateToken(
  token: string,
  opts: AuthOptions = {},
): Promise<AuthOk | AuthErr> {
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
    .select("id, user_id, revoked_at, scope")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) {
    return { ok: false, status: 500, error: error.message };
  }
  if (!row || row.revoked_at) {
    return { ok: false, status: 401, error: "Invalid or revoked token." };
  }
  const scope = (row.scope ?? null) as TokenScope | null;
  if (scope !== null && !(opts.allowScopes ?? []).includes(scope)) {
    return { ok: false, status: 403, error: `This token is read-only (${scope}) and cannot use this endpoint.` };
  }

  // Fire-and-forget last_used_at update; don't await.
  void service
    .from("sp_api_token")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(() => undefined);

  return { ok: true, userId: row.user_id, tokenId: row.id, scope };
}
