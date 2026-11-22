// PATCH /api/intent/v1/leads/:id { status: "new" | "replied" | "dismissed" }

import type { NextRequest } from "next/server";
import { setLeadStatus } from "@/lib/intent/store";
import { readJson, withOwner } from "@/lib/intent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOwner(req, async (owner) => {
    const body = await readJson(req);
    return { ok: true, lead: await setLeadStatus(owner, id, String(body.status ?? "")) };
  });
}
