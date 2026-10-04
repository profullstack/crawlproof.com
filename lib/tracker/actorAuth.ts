// Who is managing actors: a `crp_` bearer token (CLI, MCP) or a dashboard
// session. Either way the answer is a user id every actor query scopes by.

import type { NextRequest } from "next/server";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { createClient } from "@/lib/supabase/server";

export async function actorOwner(
  req: NextRequest,
): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  if (req.headers.get("authorization")) {
    const auth = await authenticateBearer(req);
    return auth.ok ? { ok: true, userId: auth.userId } : auth;
  }
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) return { ok: true, userId: data.user.id };
  } catch {
    // fall through to 401
  }
  return { ok: false, status: 401, error: "Sign in, or send Authorization: Bearer crp_…" };
}
