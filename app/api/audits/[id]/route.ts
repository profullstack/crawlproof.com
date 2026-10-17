import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { buildTodoList } from "@/lib/audit/recommendations";
import type { Finding } from "@/lib/audit/types";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const svc = serviceClient();
  const { data, error } = await svc
    .from("audits")
    .select("id, status, score, summary, completed_at, share_token, target_url")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return NextResponse.json({ ok: false }, { status: 404 });

  // The to-do list: each finding as a concrete step (exact URL, header or
  // tag to add), ordered by the score points it is worth.
  let todo: ReturnType<typeof buildTodoList> = [];
  if (data.status === "complete") {
    const { data: findings } = await svc
      .from("audit_findings")
      .select("section, check_key, status, title, detail, evidence, priority")
      .eq("audit_id", id);
    todo = buildTodoList((findings ?? []) as Finding[], data.target_url as string);
  }
  return NextResponse.json({ ok: true, audit: data, todo });
}
