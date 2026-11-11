// WebMCP plugin config for /stats.js.
// GET /api/tracker/v1/webmcp?site=<project_id>  ->  { enabled, config }
//
// stats.js only asks when the visitor's browser ships WebMCP and the tag has no
// data-webmcp attribute of its own, so this is a rare request. Unknown or
// disabled projects answer { enabled: false } (never a 404) so the failure mode
// is "no tools", not a broken host page.

import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { publicWebmcpConfig } from "@/lib/tracker/webmcp";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "public, max-age=300, s-maxage=300",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers });
}

export async function GET(request: NextRequest) {
  const site = request.nextUrl.searchParams.get("site") ?? "";
  if (!UUID.test(site)) return NextResponse.json({ enabled: false }, { headers });
  const { data } = await serviceClient()
    .from("projects")
    .select("tracker_enabled, webmcp_enabled, webmcp_config")
    .eq("id", site)
    .maybeSingle();
  const enabled = Boolean(data?.tracker_enabled && data?.webmcp_enabled);
  return NextResponse.json(
    enabled ? { enabled, config: publicWebmcpConfig(data?.webmcp_config) } : { enabled: false },
    { headers },
  );
}
