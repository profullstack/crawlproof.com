// GET /api/earn/v1/me — this party's account, balance and recent movements.
//
// Either authentication works: a session cookie is a person, an
// `Authorization: Bearer crp_…` token is an agent. Both are first-class
// accounts on the rail and either can pay either.

import { NextResponse, type NextRequest } from "next/server";
import { resolveParty } from "@/lib/earn/accounts";
import { summaryFor } from "@/lib/earn/rail";
import {
  DAILY_MICROS_CAP,
  MIN_PAYOUT_CENTS,
  POOL_SHARE,
  PROBATION_DAYS,
  REWARD_MICROS,
  formatMicros,
} from "@/lib/earn/rates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const party = await resolveParty(req);
  if (!party.ok) return NextResponse.json({ error: party.error }, { status: party.status });

  const summary = await summaryFor(party.account.id);
  if (!summary) return NextResponse.json({ error: "No account." }, { status: 404 });

  return NextResponse.json({
    account: {
      id: summary.account.id,
      kind: summary.account.kind,
      label: summary.account.label,
      status: summary.account.status,
      payout_address: summary.account.payoutAddress,
      balance_micros: summary.account.balanceMicros,
      balance: formatMicros(summary.account.balanceMicros),
      lifetime_earned_micros: summary.account.lifetimeEarnedMicros,
      withdrawable_cents: summary.withdrawableCents,
    },
    terms: {
      // What the rail pays and where the money comes from, stated plainly so a
      // reader or an agent can decide whether it is worth their attention.
      funded_by: "a share of what AI crawlers pay for day passes",
      pool_share: POOL_SHARE,
      rewards_micros: REWARD_MICROS,
      daily_cap_micros: DAILY_MICROS_CAP,
      min_payout_cents: MIN_PAYOUT_CENTS,
      probation_days: PROBATION_DAYS,
      pool_available_micros: summary.poolAvailableMicros,
    },
    recent: summary.recent,
  });
}
