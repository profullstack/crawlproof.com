// GitHub App install callback. GitHub redirects users here after they
// finish installing the App on their account / org.
//
// SECURITY (2026-11-22): installation_id arrives in the query string, so it
// proves nothing. Before binding an installation to the signed-in user we ask
// GitHub, AS THAT USER, which installations they can access
// (GET /user/installations with a user-to-server token). Previously any
// signed-in user could visit ?installation_id=<someone else's> and bind a
// stranger's installation, then commit to their repos through the install-*
// and apply-fix routes.
//
// Flow:
//   1. GitHub -> here with installation_id (+ code if "Request user
//      authorization during installation" is on).
//   2. No code: redirect to GitHub's App authorization with a signed state
//      (user id + installation id), GitHub returns here with code + state.
//   3. Exchange code for a user token, require installation_id to be in
//      /user/installations, then persist. Anything else fails closed.

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getInstallation } from "@/lib/github/app";
import { upsertInstallation } from "@/lib/github/installations";
import { publicUrl } from "@/lib/request-url";

export const runtime = "nodejs";

const SETTINGS_URL = "/dashboard/settings/integrations/github";
const CALLBACK_PATH = "/api/github/callback";
const STATE_TTL_MS = 15 * 60 * 1000;

function secret(): string {
  const s = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!s) throw new Error("GITHUB_APP_CLIENT_SECRET is not set");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** state = base64url(json{u,i,a,t}).hmac — bound to the signed-in user. */
function makeState(userId: string, installationId: string, setupAction: string | null): string {
  const body = Buffer.from(
    JSON.stringify({ u: userId, i: installationId, a: setupAction ?? "", t: Date.now() }),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

function readState(
  state: string | null,
  userId: string,
): { installationId: string; setupAction: string } | null {
  if (!state) return null;
  const [body, mac] = state.split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (s.u !== userId) return null;
    if (typeof s.t !== "number" || Date.now() - s.t > STATE_TTL_MS) return null;
    if (!/^\d+$/.test(String(s.i))) return null;
    return { installationId: String(s.i), setupAction: String(s.a ?? "") };
  } catch {
    return null;
  }
}

async function exchangeCode(code: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_APP_CLIENT_ID,
      client_secret: secret(),
      code,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`oauth_exchange_failed${data.error ? ":" + data.error : ""}`);
  }
  return data.access_token;
}

/** True only if GitHub says this user can access the installation. */
async function userCanAccessInstallation(userToken: string, installationId: string): Promise<boolean> {
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { installations?: { id: number }[] };
    const list = data.installations ?? [];
    if (list.some((i) => String(i.id) === installationId)) return true;
    if (list.length < 100) return false;
  }
  return false;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const settings = (q: string) => NextResponse.redirect(publicUrl(request.headers, `${SETTINGS_URL}?${q}`));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // Send them back to the settings page after login; it starts the
    // install again, which lands here with a fresh installation_id.
    return NextResponse.redirect(
      publicUrl(request.headers, `/login?redirect=${encodeURIComponent(SETTINGS_URL)}`),
    );
  }

  // Which installation are we being asked to bind?
  let installationId = url.searchParams.get("installation_id");
  let setupAction = url.searchParams.get("setup_action");
  if (state) {
    const s = readState(state, user.id);
    if (!s) return settings("error=install_state_invalid");
    installationId = s.installationId;
    setupAction = s.setupAction || setupAction;
  }
  if (!installationId || !/^\d+$/.test(installationId)) {
    return settings("error=missing_installation_id");
  }

  // "request" means the user requested install access on a repo they
  // don't own — there's nothing for us to persist yet.
  if (setupAction === "request") return settings("notice=install_requested");

  // No user authorization yet: get it, carrying the installation in a
  // state bound to this user.
  if (!code) {
    const clientId = process.env.GITHUB_APP_CLIENT_ID;
    if (!clientId) return settings("error=install_callback:oauth_not_configured");
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", publicUrl(request.headers, CALLBACK_PATH).toString());
    authorize.searchParams.set("state", makeState(user.id, installationId, setupAction));
    return NextResponse.redirect(authorize);
  }

  // GitHub's own install-time authorization sends code without our state;
  // that is fine, the access check below is what proves ownership.
  try {
    const userToken = await exchangeCode(code);
    if (!(await userCanAccessInstallation(userToken, installationId))) {
      return settings("error=install_not_yours");
    }
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
    return settings(`error=${encodeURIComponent("install_callback:" + msg)}`);
  }

  return settings("connected=1");
}
