// Same-origin mirror of @profullstack/webmcp for the stats.js WebMCP plugin.
// GET /npm/@profullstack/webmcp@0/src/<module>.js
//
// Sites that run stats.js allow crawlproof.com in their CSP but often not
// cdn.jsdelivr.net, so the plugin loads the embed from here. Only the
// package's own modules are served, fetched from jsDelivr's @0 alias so a
// new 0.x release reaches every site without a crawlproof deploy. The embed
// imports its siblings relatively, so they resolve back to this route.

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const MODULES = new Set(["embed.js", "core.js", "site.js", "forms.js", "mcp-bridge.js", "index.js"]);
const PREFIX = ["@profullstack", "webmcp@0", "src"];
const UPSTREAM = "https://cdn.jsdelivr.net/npm/@profullstack/webmcp@0/src/";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const file = path?.[3];
  if (!path || path.length !== 4 || PREFIX.some((p, i) => path[i] !== p) || !file || !MODULES.has(file)) {
    return new NextResponse("not found", { status: 404 });
  }
  const upstream = await fetch(UPSTREAM + file, { next: { revalidate: 900 } }).catch(() => null);
  if (!upstream?.ok) return new NextResponse("upstream unavailable", { status: 502 });
  return new NextResponse(await upstream.text(), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      // Module scripts are fetched in CORS mode from the customer's origin.
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=900, s-maxage=900",
      "x-webmcp-version": upstream.headers.get("x-jsd-version") ?? "",
    },
  });
}
