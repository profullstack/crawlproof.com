// App Manifest conversion callback. After the org admin clicks "Create
// GitHub App for Profullstack" on the setup page, GitHub redirects here
// with a one-shot `code` that we exchange for the App's secrets. We
// don't persist any of it server-side — we render it once for the admin
// to copy into Railway, and never see it again.

import { NextRequest, NextResponse } from "next/server";
import { convertAppManifest } from "@/lib/github/app";
import { publicUrl } from "@/lib/request-url";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const code = new URL(request.url).searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      publicUrl(request.headers, "/dashboard/admin/github/setup?error=missing_code"),
    );
  }
  try {
    const result = await convertAppManifest(code);
    // Stash the secrets in a one-shot, in-memory-only response. The
    // result page reads them from the URL fragment via a tiny client
    // script so they never appear in our logs or analytics.
    const params = new URLSearchParams({
      app_id: String(result.id),
      slug: result.slug,
      client_id: result.client_id,
      client_secret: result.client_secret,
      webhook_secret: result.webhook_secret ?? "",
      pem: result.pem,
      html_url: result.html_url,
      owner: result.owner.login,
    });
    return NextResponse.redirect(
      publicUrl(request.headers, `/dashboard/admin/github/setup/done#${params.toString()}`),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.redirect(
      publicUrl(
        request.headers,
        `/dashboard/admin/github/setup?error=${encodeURIComponent(msg)}`,
      ),
    );
  }
}
