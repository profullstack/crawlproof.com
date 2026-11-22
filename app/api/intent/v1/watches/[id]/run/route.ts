// POST /api/intent/v1/watches/:id/run   sweep now (costs one sweep's credits)

import type { NextRequest } from "next/server";
import { runWatchNow } from "@/lib/intent/store";
import { withOwner } from "@/lib/intent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOwner(req, async (owner) => {
    const r = await runWatchNow(owner, id);
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    return { ok: true, found: r.found, new_leads: r.inserted, searches: r.calls, deliveries: r.deliveries, notes: r.notes };
  });
}
