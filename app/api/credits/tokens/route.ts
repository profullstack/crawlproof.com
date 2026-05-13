import { NextResponse } from "next/server";
import { fetchSupportedTokens } from "@/lib/coinpay-tokens";

export const runtime = "nodejs";

// GET /api/credits/tokens
// Returns the merchant's active CoinPay tokens. The buy-credits modal
// renders one button per token (plus a Card option appended client-side).
export async function GET() {
  const tokens = await fetchSupportedTokens();
  return NextResponse.json({ ok: true, tokens });
}
