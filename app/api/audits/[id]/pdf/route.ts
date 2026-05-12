import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // PDF export is included with every scan — the credit already paid for it.
  const { data: audit } = await supabase
    .from("audits")
    .select("share_token, owner_id, status, report_markdown, target_url, score")
    .eq("id", id)
    .maybeSingle();
  if (!audit || audit.owner_id !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (audit.status !== "complete") {
    return NextResponse.json({ error: "Audit not complete yet" }, { status: 425 });
  }
  if (!audit.report_markdown) {
    return NextResponse.json({ error: "Report markdown missing." }, { status: 500 });
  }

  if (!env.workerUrl) {
    return NextResponse.json({ error: "Worker not configured" }, { status: 500 });
  }

  // Worker pandoc-converts the markdown and renders the result as PDF.
  const workerRes = await fetch(`${env.workerUrl}/pdf`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": env.workerSecret },
    body: JSON.stringify({
      markdown: audit.report_markdown,
      title: `AEO Audit — ${new URL(audit.target_url).hostname}`,
      target: audit.target_url,
      score: audit.score,
    }),
  });
  if (!workerRes.ok) {
    return NextResponse.json({ error: "PDF render failed" }, { status: 502 });
  }
  const buf = await workerRes.arrayBuffer();
  return new NextResponse(buf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="crawlproof-${id.slice(0, 8)}.pdf"`,
    },
  });
}
