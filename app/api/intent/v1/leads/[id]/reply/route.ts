// POST /api/intent/v1/leads/:id/reply { regenerate?: boolean }
// Drafts a reply you post yourself. 1 credit per new draft.

import type { NextRequest } from "next/server";
import { draftLeadReply } from "@/lib/intent/store";
import { readJson, withOwner } from "@/lib/intent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withOwner(req, async (owner) => {
    const body = await readJson(req);
    return { ok: true, reply: await draftLeadReply(owner, id, body.regenerate === true) };
  });
}
