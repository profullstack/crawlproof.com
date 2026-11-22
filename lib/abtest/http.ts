// Shared plumbing for /api/abtest/v1/*: bearer auth (crp_ token, read-only tokens may
// GET) and AbError -> JSON.
import { NextResponse, type NextRequest } from "next/server";
import { authenticateBearer, STATS_READ } from "@/lib/sp/apiAuth";
import { AbError } from "@/lib/abtest/store";

export async function authed(req: NextRequest, read = false) {
  const auth = await authenticateBearer(req, read ? { allowScopes: [STATS_READ] } : {});
  if (!auth.ok) return { error: NextResponse.json({ error: auth.error }, { status: auth.status }) } as const;
  return { userId: auth.userId } as const;
}

export function errorResponse(e: unknown) {
  if (e instanceof AbError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[abtest]", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}

export async function jsonBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new AbError(400, "body must be JSON");
  }
}

export const dashboardUrl = (key: string) => `https://crawlproof.com/dashboard/experiments/${encodeURIComponent(key)}`;
