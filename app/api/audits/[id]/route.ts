import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const svc = serviceClient();
  const { data, error } = await svc
    .from("audits")
    .select("id, status, score, summary, completed_at, share_token")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return NextResponse.json({ ok: false }, { status: 404 });
  return NextResponse.json({ ok: true, audit: data });
}
