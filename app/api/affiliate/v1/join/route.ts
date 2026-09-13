// POST /api/affiliate/v1/join — join the program CrawlProof runs.
//
// Public: an outside affiliate sends { profile, pay?, webhook?, code? } and
// gets a membership, a code, a link and a token shown once. A signed-in user
// or API token joins without a profile; the membership is theirs.
import { NextResponse, type NextRequest } from "next/server";
import { parseJoinRequest } from "@/lib/affiliate/spec";
import { joinOurProgram, linkForMembership } from "@/lib/affiliate/memberships";
import { PROGRAM_ID } from "@/lib/affiliate/program";
import { env } from "@/lib/env";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "POST, OPTIONS" };

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (typeof body === "object" && body && "program" in body && (body as { program?: unknown }).program && (body as { program: string }).program !== PROGRAM_ID) {
    return NextResponse.json({ error: `Unknown program. This merchant runs "${PROGRAM_ID}".` }, { status: 404, headers: CORS });
  }

  // Our own user, if any: the membership is linked to the account.
  let owner: { id: string; email: string | null } | null = null;
  const header = req.headers.get("authorization") ?? "";
  if (/^bearer\s+crp_/i.test(header)) {
    const auth = await authenticateBearer(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: CORS });
    owner = { id: auth.userId, email: null };
  } else if (!header) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) owner = { id: user.id, email: user.email ?? null };
  }

  const parsed = parseJoinRequest(body);
  if (!parsed.ok && !owner) return NextResponse.json({ error: parsed.error }, { status: 400, headers: CORS });
  const request = parsed.ok ? parsed.request : {};

  const joined = await joinOurProgram(request, { ownerId: owner?.id ?? null, email: owner?.email ?? null });
  if (!joined.ok) return NextResponse.json({ error: joined.error }, { status: joined.status, headers: CORS });

  const m = joined.membership;
  return NextResponse.json(
    {
      membership: m.id,
      program: m.program,
      status: m.status,
      code: m.code,
      link: linkForMembership(m),
      ...(joined.token ? { token: joined.token } : {}),
      ledger: `${env.siteUrl.replace(/\/$/, "")}/api/affiliate/v1/ledger`,
      pays: m.terms,
      existing: joined.existing,
      ...(joined.existing && !joined.token
        ? { note: "This profile already has a membership. The token was shown at the first join; rotate it with POST /api/affiliate/v1/token from the account it belongs to." }
        : {}),
    },
    { status: joined.existing ? 200 : 201, headers: CORS },
  );
}
