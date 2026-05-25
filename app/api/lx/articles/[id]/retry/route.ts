import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { deliverArticle } from "@/lib/lx/webhookDeliver";

export const runtime = "nodejs";

// Re-attempt webhook delivery for a previously-failed article. Flips
// status back to 'ready' (gated on it currently being 'failed' so we
// can't accidentally re-deliver an already-published post) and queues
// the worker.
export async function POST(
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
  // Verify the article belongs to the caller's site, and reset state.
  const { data: article } = await supabase
    .from("lx_article")
    .select("id, site_id, status, lx_site!lx_article_site_id_fkey!inner(user_id)")
    .eq("id", id)
    .maybeSingle();
  if (!article || (article as any).lx_site?.user_id !== user.id) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  if (article.status !== "failed") {
    return NextResponse.json(
      { ok: false, error: `article is ${article.status}; only 'failed' can retry` },
      { status: 400 },
    );
  }

  const svc = serviceClient();
  const { error } = await svc
    .from("lx_article")
    .update({ status: "ready", webhook_last_error: null })
    .eq("id", id)
    .eq("status", "failed");
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const delivery = await deliverArticle(id, { supabase: svc });
  return NextResponse.json({
    ok: delivery.ok,
    delivery,
    error: delivery.ok ? undefined : delivery.error ?? "delivery failed",
  }, { status: delivery.ok ? 200 : 422 });
}
