// GET  /api/affiliate/v1/me — the caller's membership, link and ledger.
// POST /api/affiliate/v1/me { pay?, webhook? } — set where the money goes and where events go.
import { NextResponse, type NextRequest } from "next/server";
import { resolveCaller } from "@/lib/affiliate/auth";
import { ledgerFor, membershipById, profileUrlForMembership, setPayAddress, setWebhook } from "@/lib/affiliate/memberships";
import { isPayAddress } from "@/lib/affiliate/spec";
import { HOLD_DAYS, PAYOUT_METHOD, PAYOUT_MIN_CENTS, WINDOW_DAYS, termsLine } from "@/lib/affiliate/program";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function answer(membershipId: string) {
  const m = await membershipById(membershipId);
  if (!m) return NextResponse.json({ error: "Membership vanished." }, { status: 404 });
  const ledger = await ledgerFor(m);
  return NextResponse.json({
    membership: {
      id: m.id,
      program: m.program,
      status: m.status,
      code: m.code,
      link: ledger.link,
      profile: profileUrlForMembership(m),
      pay_address: m.payAddress,
      webhook: m.webhookUrl,
      token_prefix: m.tokenPrefix,
      created_at: m.createdAt,
    },
    terms: { pays: m.terms, window_days: WINDOW_DAYS, hold_days: HOLD_DAYS, payout_method: PAYOUT_METHOD, payout_min_cents: PAYOUT_MIN_CENTS, line: termsLine() },
    ledger,
  });
}

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  return answer(caller.membership.id);
}

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Send JSON." }, { status: 400 });
  }
  if ("pay" in body) {
    const pay = body.pay === null || body.pay === "" ? null : body.pay;
    if (pay !== null && !isPayAddress(pay)) return NextResponse.json({ error: "pay must be an EVM address (0x…, 42 characters) or a CAIP-10 account." }, { status: 400 });
    const set = await setPayAddress(caller.membership.id, pay as string | null);
    if (!set.ok) return NextResponse.json({ error: set.error }, { status: 500 });
  }
  if ("webhook" in body) {
    const w = body.webhook;
    if (w !== null && w !== "" && (typeof w !== "string" || !/^https:\/\//.test(w))) return NextResponse.json({ error: "webhook must be an https URL." }, { status: 400 });
    await setWebhook(caller.membership.id, w ? String(w) : null);
  }
  return answer(caller.membership.id);
}
