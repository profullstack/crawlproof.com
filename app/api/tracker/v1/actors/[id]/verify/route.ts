// /api/tracker/v1/actors/:id/verify?t=… — the link in the verification email.
// Public on purpose: holding the emailed token is the proof.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { verifyActorEmail } from "@/lib/tracker/actorStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function page(title: string, body: string, status: number) {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
      `<body style="font:16px/1.6 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 16px"><h1>${esc(title)}</h1><p>${esc(body)}</p>` +
      `<p><a href="/dashboard/settings/actors">Declared actors</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await verifyActorEmail(serviceClient(), id, req.nextUrl.searchParams.get("t") ?? "");
  if (!res.ok) return page("Not verified", res.error, res.status);
  return page("Address verified", `${res.value.email} is now a verified declared actor.`, 200);
}
