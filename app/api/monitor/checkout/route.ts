import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { funnelContext } from "@/lib/funnel";
import { isMonitorPlan, openMonitorCheckout } from "@/lib/monitoring";

export const runtime = "nodejs";

// Start (or renew) a weekly-monitoring month. Answers { url } on CoinPay's
// hosted checkout (any coin, or a card through PayPal). Signed-in only, since
// cancelling and managing sites is self-serve from the dashboard.
const Body = z.object({
  plan: z.string(),
  token: z.string().max(64).optional().nullable(),
  subscriptionId: z.string().uuid().optional().nullable(),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!parsed.success || !isMonitorPlan(parsed.data.plan)) {
    return NextResponse.json({ ok: false, error: "Unknown plan." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "signin_required" }, { status: 401 });
  if (!user.email) {
    return NextResponse.json({ ok: false, error: "Your account has no email address." }, { status: 400 });
  }

  const ctx = funnelContext(req.headers.get("cookie"));
  const res = await openMonitorCheckout({
    userId: user.id,
    email: user.email,
    plan: parsed.data.plan,
    subscriptionId: parsed.data.subscriptionId ?? null,
    originToken: parsed.data.token ?? null,
    source: ctx.source,
    visitorId: ctx.visitorId,
  });
  if (!res.ok) return NextResponse.json(res, { status: 502 });
  return NextResponse.json({ ok: true, url: res.url });
}
