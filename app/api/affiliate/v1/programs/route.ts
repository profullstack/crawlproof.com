// GET  /api/affiliate/v1/programs — the directory: every program read from a merchant's own file.
// POST /api/affiliate/v1/programs { url } — read a merchant and add it (signed in or API token).
import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { addOrRefreshProgram, listDirectory } from "@/lib/affiliate/directory";
import { linkFor } from "@/lib/affiliate/spec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const programs = await listDirectory();
  return NextResponse.json({
    programs: programs.map((p) => ({
      origin: p.origin,
      merchant: p.merchant.name,
      web: p.merchant.web ?? p.origin,
      currency: p.merchant.currency,
      terms: p.merchant.terms ?? null,
      id: p.program.id,
      title: p.program.title,
      url: p.program.url ?? null,
      join: p.program.join ?? null,
      approval: p.program.approval,
      pays: p.program.pays,
      window: p.program.window ?? null,
      attribution: p.program.attribution,
      hold_days: p.program.hold_days ?? null,
      payout: p.program.payout ?? null,
      self: p.program.self,
      status: p.program.status,
      example_link: linkFor(p.program, "you", p.merchant.web ?? p.origin),
      verified: p.verified,
      read_at: p.fetchedAt,
    })),
  }, { headers: { "cache-control": "public, max-age=300" } });
}

export async function POST(req: NextRequest) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  let body: { url?: unknown } = {};
  try {
    body = (await req.json()) as { url?: unknown };
  } catch {
    /* empty */
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return NextResponse.json({ error: "Send { url } for the merchant." }, { status: 400 });
  const out = await addOrRefreshProgram(url, who.user.id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 422 });
  return NextResponse.json({
    origin: out.row.origin,
    verified: out.row.verified,
    merchant: out.row.descriptor?.merchant.name ?? null,
    programs: out.row.descriptor?.programs.map((p) => ({ id: p.id, title: p.title, pays: p.pays, approval: p.approval, join: p.join ?? null, status: p.status })) ?? [],
    warnings: out.warnings,
  }, { status: 201 });
}
