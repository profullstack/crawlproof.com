import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import {
  buildScanRunMarkdown,
  type SummaryRow,
} from "@/lib/audit/summary-markdown";

export const runtime = "nodejs";

// Owner PDF download. For multi-engine scan runs the response is the
// consolidated PDF (executive summary + every engine's full report).
// Solo runs return the single audit's PDF as before.
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

  const { data: audit } = await supabase
    .from("audits")
    .select(
      "id, share_token, owner_id, status, report_markdown, target_url, score, scan_run_id",
    )
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

  let markdown = audit.report_markdown;
  let title = `AEO Audit — ${new URL(audit.target_url).hostname}`;
  let scoreForPdf: number | null = audit.score;

  if (audit.scan_run_id) {
    const { data: siblings } = await supabase
      .from("audits")
      .select(
        "id, engine, status, score, share_token, summary, report_markdown, failed_reason, created_at",
      )
      .eq("scan_run_id", audit.scan_run_id)
      .eq("owner_id", user.id)
      .order("created_at", { ascending: true });
    const rows = (siblings ?? []) as SummaryRow[];
    if (rows.length > 1) {
      markdown = buildScanRunMarkdown({ targetUrl: audit.target_url, rows });
      const completed = rows.filter(
        (r) => r.status === "complete" && r.score !== null,
      );
      scoreForPdf =
        completed.length > 0
          ? Math.round(
              completed.reduce((s, r) => s + (r.score ?? 0), 0) /
                completed.length,
            )
          : null;
      title = `AEO Audit — ${new URL(audit.target_url).hostname} (${rows.length} engines)`;
    }
  }

  const workerRes = await fetch(`${env.workerUrl}/pdf`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": env.workerSecret },
    body: JSON.stringify({
      markdown,
      title,
      target: audit.target_url,
      score: scoreForPdf,
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
