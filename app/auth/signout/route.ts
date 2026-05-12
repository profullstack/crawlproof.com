import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // Use the configured public URL, not request.url — inside Railway the
  // request URL has the container's bind address (e.g. 0.0.0.0:8080).
  const origin =
    env.siteUrl?.replace(/\/$/, "") ??
    `https://${request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? ""}`;
  return NextResponse.redirect(new URL("/", origin), { status: 303 });
}
