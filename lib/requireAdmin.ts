// is_admin gate for API routes, by session cookie or crp_ API token.

import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { serviceClient } from "@/lib/supabase/service";

export async function requireAdmin(
  req: NextRequest,
): Promise<{ ok: true; userId: string } | { ok: false; res: NextResponse }> {
  const who = await resolveUser(req);
  if (!who.ok) return { ok: false, res: NextResponse.json({ error: who.error }, { status: who.status }) };
  const { data } = await serviceClient().from("profiles").select("is_admin").eq("id", who.user.id).maybeSingle();
  if (!data?.is_admin) return { ok: false, res: NextResponse.json({ error: "Admin only." }, { status: 403 }) };
  return { ok: true, userId: who.user.id };
}
