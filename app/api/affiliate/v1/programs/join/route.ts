// POST /api/affiliate/v1/programs/join { origin | url, program?, code? } —
// join another merchant's program as the caller, with the caller's own
// CrawlProof profile and pay address.
import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { joinExternal } from "@/lib/affiliate/directory";
import { isAffiliateCode } from "@/lib/affiliate/spec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* empty */
  }
  const origin = typeof body.origin === "string" ? body.origin : typeof body.url === "string" ? body.url : "";
  if (!origin.trim()) return NextResponse.json({ error: "Send { origin } (or { url }) for the merchant." }, { status: 400 });
  const programId = typeof body.program === "string" && body.program ? body.program : undefined;
  const code = typeof body.code === "string" && body.code ? body.code : undefined;
  if (code && !isAffiliateCode(code)) return NextResponse.json({ error: "code must be 3 to 32 lower-case letters, digits or dashes." }, { status: 400 });
  const out = await joinExternal(who.user, { origin: origin.trim(), programId, code });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 422 });
  const j = out.join;
  return NextResponse.json({
    join: { id: j.id, origin: j.origin, program: j.programId, status: j.status, code: j.code, link: j.link, ledger: j.ledgerUrl, terms: j.terms, synced_at: j.syncedAt },
    existing: out.existing,
  }, { status: out.existing ? 200 : 201 });
}
