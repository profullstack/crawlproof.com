// POST /api/earn/v1/fund { amount_cents, ref, reason? } — crawler money in.
//
// A crawler bought a day pass; a share of what it paid becomes the reward pool
// that readers are paid from. Idempotent on `ref` (the pass payment's own id),
// because a settlement notice is a reason to record money rather than proof it
// has not already been recorded.
//
// Authenticated with the worker secret, not a user session: the caller is the
// settlement path, not a person. This is the only way value enters the pool,
// which is what makes the rail solvent — readers can never be paid more than
// crawlers have actually paid in.

import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { fundPoolFromPass, poolAvailableMicros } from "@/lib/earn/rail";
import { POOL_SHARE, formatMicros } from "@/lib/earn/rates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = env.workerSecret;
  if (!secret) return false;
  const given = req.headers.get("x-worker-secret") ?? "";
  if (given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= given.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const amountCents = Math.floor(Number(body.amount_cents));
  const ref = String(body.ref ?? "").trim();
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return NextResponse.json({ error: "amount_cents must be a positive whole number." }, { status: 400 });
  }
  if (!ref) {
    return NextResponse.json({ error: "ref is required, so the same payment funds the pool once." }, { status: 400 });
  }

  const result = await fundPoolFromPass({
    amountCents,
    ref,
    reason: body.reason == null ? undefined : String(body.reason).slice(0, 200),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({
    pool_share: POOL_SHARE,
    available_micros: result.availableMicros,
    available: formatMicros(result.availableMicros),
  });
}

// GET — what is left to reward. Handy for a status check without a write.
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const available = await poolAvailableMicros();
  return NextResponse.json({ available_micros: available, available: formatMicros(available) });
}
