// GET /api/sp/v1/accounts — list the authenticated user's connected
// social accounts. Used by the sh1pt CLI (and any other integration)
// to discover what to post to.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const service = serviceClient();
  const { data, error } = await service
    .from("sp_account")
    .select(
      "id, platform, handle, status, instance_url, last_post_at, created_at",
    )
    .eq("user_id", auth.userId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    accounts: (data ?? []).map((a: any) => ({
      id: a.id,
      platform: a.platform,
      handle: a.handle,
      status: a.status,
      instance_url: a.instance_url ?? null,
      last_post_at: a.last_post_at,
      created_at: a.created_at,
    })),
  });
}
