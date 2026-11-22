// GET  /api/intent/v1/watches        list your Buyer Intent watches
// POST /api/intent/v1/watches        create one { name, keywords, competitors, sells, sources, cadence, ... }

import type { NextRequest } from "next/server";
import { createWatch, listWatches, publicWatch, type WatchInput } from "@/lib/intent/store";
import { readJson, withOwner } from "@/lib/intent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return withOwner(req, async (owner) => ({ watches: (await listWatches(owner)).map((w) => publicWatch(w)) }));
}

export async function POST(req: NextRequest) {
  return withOwner(req, async (owner) => {
    const w = await createWatch(owner, (await readJson(req)) as WatchInput);
    return Response.json({ ok: true, watch: publicWatch(w) }, { status: 201 });
  });
}
