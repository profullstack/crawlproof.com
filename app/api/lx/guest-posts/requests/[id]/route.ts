import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// "Unclick" a guest-post request — delete the lx_guest_post_request
// row. The DB-level DELETE RLS policy blocks deletion once status
// reaches 'generated' (the article exists and may already have been
// delivered via webhook). queued / generating / failed are all
// removable. If the worker picks up a request whose row has been
// deleted, processLxGuestPost detects the missing row and bails
// before consuming any credits.
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;

  // Read first so we can give a clearer 409 than "deleted 0 rows"
  // when the row is locked. RLS ensures we only see our own rows.
  const { data: existing } = await supabase
    .from("lx_guest_post_request")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  if (existing.status === "generated") {
    return NextResponse.json(
      {
        ok: false,
        error: "Already generated — open the article to delete it from the dashboard.",
      },
      { status: 409 },
    );
  }

  const { error } = await supabase
    .from("lx_guest_post_request")
    .delete()
    .eq("id", id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
