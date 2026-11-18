import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/requireAdmin";
import { BATCH_MAX, createBatch, isBatchSource, readBatch } from "@/lib/batch-audits";

export const runtime = "nodejs";

// R4 batch audits, admin only (session or crp_ token). Used by
// `crawlproof batch domains.csv`.
//
//   POST { domains: string[], source: "outreach" | "ranking", batch_id? }
//     -> { batch_id, created: [{domain,url,token}], rejected: [{domain,reason}] }
//   GET ?batch=<uuid>
//     -> { rows: [{domain,status,score,top_issue,report_url,...}], done, total }

const Body = z.object({
  domains: z.array(z.string().min(1).max(300)).min(1).max(BATCH_MAX),
  source: z.string(),
  batch_id: z.string().uuid().optional(),
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
  if (!parsed.success || !isBatchSource(parsed.data.source)) {
    return NextResponse.json(
      { error: `Send { domains: [...up to ${BATCH_MAX}], source: "outreach" | "ranking" }.` },
      { status: 400 },
    );
  }
  const res = await createBatch({
    domains: parsed.data.domains,
    source: parsed.data.source,
    batchId: parsed.data.batch_id ?? null,
  });
  return NextResponse.json({ batch_id: res.batchId, created: res.created, rejected: res.rejected });
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.res;
  const batch = req.nextUrl.searchParams.get("batch") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(batch)) return NextResponse.json({ error: "batch=<uuid> required" }, { status: 400 });
  const rows = await readBatch(batch);
  const done = rows.filter((r) => r.status === "complete" || r.status === "failed").length;
  return NextResponse.json({ batch_id: batch, rows, done, total: rows.length });
}
