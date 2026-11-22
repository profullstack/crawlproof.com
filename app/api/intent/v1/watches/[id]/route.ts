// GET / PATCH / DELETE /api/intent/v1/watches/:id

import type { NextRequest } from "next/server";
import { deleteWatch, getWatch, publicWatch, updateWatch, type WatchInput } from "@/lib/intent/store";
import { readJson, withOwner } from "@/lib/intent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return withOwner(req, async (owner) => ({ watch: publicWatch(await getWatch(owner, id)) }));
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return withOwner(req, async (owner) => ({
    ok: true,
    watch: publicWatch(await updateWatch(owner, id, (await readJson(req)) as WatchInput)),
  }));
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  return withOwner(req, async (owner) => {
    await deleteWatch(owner, id);
    return { ok: true };
  });
}
