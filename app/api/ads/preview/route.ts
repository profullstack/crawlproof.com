import { NextResponse, type NextRequest } from "next/server";
import { previewAds } from "@/app/actions/ads";

// A route and not a server action on purpose: Next runs a client's server
// actions one at a time, and this takes minutes on c0mpute. As an action it
// would hold back every Save and logo upload on the form behind it.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
  if (typeof body?.url !== "string") {
    return NextResponse.json({ ok: false, error: "url is required." }, { status: 400 });
  }
  const result = await previewAds({ url: body.url });
  const status = result.ok || result.error !== "Not authenticated." ? 200 : 401;
  return NextResponse.json(result, { status });
}
