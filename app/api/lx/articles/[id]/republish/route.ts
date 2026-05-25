import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { deliverArticle } from "@/lib/lx/webhookDeliver";

export const runtime = "nodejs";

// Force a fresh delivery of a previously-published article. Unlike
// /retry (which only handles 'failed'), this also accepts 'published'
// so an admin can re-fire delivery when the receiver's blog_posts row
// was deleted or corrupted. Idempotent on the receiver side: the
// crawlproof webhook upserts on (source, source_id) so re-delivery
// replaces rather than duplicates.
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
  const { data: article } = await supabase
    .from("lx_article")
    .select("id, status, lx_site!lx_article_site_id_fkey!inner(user_id)")
    .eq("id", id)
    .maybeSingle();
  if (!article || (article as any).lx_site?.user_id !== user.id) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }
  if (article.status !== "published" && article.status !== "failed") {
    return NextResponse.json(
      {
        ok: false,
        error: `article is '${article.status}'; republish requires 'published' or 'failed'`,
      },
      { status: 400 },
    );
  }

  // Flip back to 'ready' so the worker's atomic claim
  // (ready -> publishing) can pick it up. webhook_last_error is cleared
  // so the previous failure (if any) doesn't ghost the UI.
  const svc = serviceClient();
  const { error } = await svc
    .from("lx_article")
    .update({ status: "ready", webhook_last_error: null })
    .eq("id", id)
    .in("status", ["published", "failed"]);
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
