// GitHub App install callback. GitHub redirects users here after they
// finish installing the App on their account / org. We look up the
// installation via the App JWT, persist the row, then bounce back to the
// settings page.
//
// Query params from GitHub:
//   installation_id: number     — required, identifies the install
//   setup_action:    string     — 'install' | 'update' | 'request'

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getInstallation } from "@/lib/github/app";
import { upsertInstallation } from "@/lib/github/installations";
import { publicUrl } from "@/lib/request-url";

export const runtime = "nodejs";

const SETTINGS_URL = "/dashboard/settings/integrations/github";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");

  if (!installationId) {
    return NextResponse.redirect(
      publicUrl(request.headers, `${SETTINGS_URL}?error=missing_installation_id`),
    );
  }

  // User must be signed in to bind this installation to their account.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // Park them at login with this callback as the redirect.
    const back = `${SETTINGS_URL}?installation_id=${installationId}`;
    return NextResponse.redirect(
      publicUrl(request.headers, `/login?redirect=${encodeURIComponent(back)}`),
    );
  }

  // "request" means the user requested install access on a repo they
  // don't own — there's nothing for us to persist yet.
  if (setupAction === "request") {
    return NextResponse.redirect(
      publicUrl(request.headers, `${SETTINGS_URL}?notice=install_requested`),
    );
  }

  try {
    const meta = await getInstallation(installationId);
    await upsertInstallation({
      userId: user.id,
      installationId: meta.id,
      accountLogin: meta.account.login,
      accountType: meta.account.type,
      accountId: meta.account.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.redirect(
      publicUrl(
        request.headers,
        `${SETTINGS_URL}?error=${encodeURIComponent("install_callback:" + msg)}`,
      ),
    );
  }

  return NextResponse.redirect(
    publicUrl(request.headers, `${SETTINGS_URL}?connected=1`),
  );
}
