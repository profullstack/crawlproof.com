import { NextResponse } from "next/server";
import { PIXEL_GIF, recordOpen } from "@/lib/outreach/openTracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The open-tracking pixel.
 *
 * Always 200s with the same one-pixel GIF, whatever the token turns out to be.
 * A 404 for an unknown token would let anyone test tokens for validity, and a
 * broken image in somebody's inbox is a worse outcome than a lost datapoint.
 *
 * Recording happens before the response for the same reason a send is logged
 * before it is reported: an open that is served but not counted is invisible,
 * and there is no retry for an image load.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  try {
    await recordOpen({
      // The .gif suffix is cosmetic — it exists so the URL reads as an image.
      token: token.replace(/\.(gif|png)$/i, ""),
      userAgent: req.headers.get("user-agent"),
    });
  } catch {
    // A failure to record is not a reason to break the email.
  }

  return new NextResponse(new Uint8Array(PIXEL_GIF), {
    status: 200,
    headers: {
      "content-type": "image/gif",
      "content-length": String(PIXEL_GIF.length),
      // Every layer asked not to cache: a cached pixel is one open forever.
      "cache-control": "no-store, no-cache, must-revalidate, private, max-age=0",
      pragma: "no-cache",
      expires: "0",
    },
  });
}
