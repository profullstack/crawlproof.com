import { NextResponse } from "next/server";
import { sendMarketingBlast } from "@/lib/marketingSend";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

// POST /api/marketing/blast
//
// Body: { subject: string, html: string, previewTo?: string, perSecond?: number }
//
// Gated by the same x-cron-secret/Bearer header pattern as the scheduled
// audit cron. `previewTo` restricts the blast to a single (opted-in)
// address — always do a preview run before a live blast.
export async function POST(req: Request) {
  const incoming =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!env.cronSecret || incoming !== env.cronSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: {
    subject?: string;
    html?: string;
    previewTo?: string;
    perSecond?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  if (!body.subject || !body.html) {
    return NextResponse.json(
      { ok: false, error: "subject and html are required" },
      { status: 400 },
    );
  }

  const result = await sendMarketingBlast({
    subject: body.subject,
    html: body.html,
    previewTo: body.previewTo,
    perSecond: body.perSecond,
  });

  return NextResponse.json({ ok: true, ...result });
}
