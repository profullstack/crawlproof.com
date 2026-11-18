import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/requireAdmin";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";

export const runtime = "nodejs";

// R5: publish a batch as a public ranking at /rankings/<slug>. Admin only.
//   POST { slug, title, list_name, method, batch_id, publish?: boolean }
const Body = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/),
  title: z.string().min(3).max(200),
  list_name: z.string().min(2).max(200),
  method: z.string().min(10).max(2000),
  batch_id: z.string().uuid(),
  publish: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.res;
  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid" }, { status: 400 });
  }
  const { publish = true, ...fields } = parsed.data;
  const { error } = await serviceClient()
    .from("rankings")
    .upsert({ ...fields, published_at: publish ? new Date().toISOString() : null }, { onConflict: "slug" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    ok: true,
    url: `${(env.siteUrl || "https://crawlproof.com").replace(/\/$/, "")}/rankings/${fields.slug}`,
    published: publish,
  });
}
