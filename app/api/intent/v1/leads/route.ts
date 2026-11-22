// GET /api/intent/v1/leads?watch=&tier=hot|engage|monitor&status=&source=&limit=&format=csv

import type { NextRequest } from "next/server";
import { listLeads } from "@/lib/intent/store";
import { leadsToCsv, type LeadTier } from "@/lib/intent/tiers";
import { withOwner } from "@/lib/intent/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  return withOwner(req, async (owner) => {
    const tier = sp.get("tier");
    const leads = await listLeads(owner, {
      watchId: sp.get("watch"),
      tier: tier === "hot" || tier === "engage" || tier === "monitor" ? (tier as LeadTier) : null,
      status: sp.get("status"),
      source: sp.get("source"),
      limit: Number(sp.get("limit") ?? 200) || 200,
    });
    if (sp.get("format") === "csv") {
      return new Response(leadsToCsv(leads), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="crawlproof-buyer-intent-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }
    return { leads };
  });
}
