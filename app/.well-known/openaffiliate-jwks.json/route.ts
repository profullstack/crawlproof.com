// The public key our affiliate webhooks are signed with (spec, "Webhooks").
// An empty set means webhooks are unsigned and the ledger is the truth.
import { NextResponse } from "next/server";
import { publicJwk } from "@/lib/affiliate/webhooks";

export const dynamic = "force-dynamic";

export function GET() {
  const jwk = publicJwk();
  return NextResponse.json({ keys: jwk ? [jwk] : [] }, {
    headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" },
  });
}
