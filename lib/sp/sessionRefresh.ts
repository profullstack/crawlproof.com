// Daily keep-alive for cookie-auth social accounts.
//
// Cookie sessions aren't OAuth tokens — there's no refresh token to exchange.
// But most sites issue sliding-expiry session cookies that get extended on
// activity, so reloading the site once a day with the current cookies and
// re-saving whatever the site hands back lengthens the session and staves off
// premature "token_expired". It also detects a session that HAS died and flags
// the account proactively, so the user is prompted to reconnect before a
// scheduled Promote post fails. It cannot revive an already-dead session.

import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptSecret, decryptSecret } from "@/lib/sp/vault";
import { parseCookies, refreshCookieSession } from "@/lib/sp/platforms/browser";

// The URL to load to keep each platform's cookie session warm.
function homeUrl(platform: string, instanceUrl: string | null): string | null {
  switch (platform) {
    case "reddit":
      return "https://www.reddit.com";
    case "facebook_page":
      return "https://www.facebook.com";
    case "threads":
      return "https://www.threads.com";
    case "instagram":
      return "https://www.instagram.com";
    case "linkedin":
      return "https://www.linkedin.com/feed/";
    case "x":
      return "https://x.com/home";
    case "mastodon": {
      const host = (instanceUrl ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
      return host ? `https://${host}` : "https://mastodon.social";
    }
    default:
      return null;
  }
}

type Row = {
  id: string;
  platform: string;
  instance_url: string | null;
  enc_access_token: string | null;
};

export type SessionRefreshResult = {
  checked: number;
  refreshed: number;
  expired: number;
  skipped: number;
};

export async function refreshCookieSessions(
  supabase: SupabaseClient<any>,
  opts: { maxAgeHours?: number } = {},
): Promise<SessionRefreshResult> {
  const maxAge = opts.maxAgeHours ?? 23;
  const cutoff = new Date(Date.now() - maxAge * 3_600_000).toISOString();
  const out: SessionRefreshResult = { checked: 0, refreshed: 0, expired: 0, skipped: 0 };

  // Active cookie accounts not refreshed within the window (the gate keeps
  // worker restarts from re-warming a session we just warmed).
  const { data } = await supabase
    .from("sp_account")
    .select("id, platform, instance_url, enc_access_token")
    .eq("auth_mode", "cookie")
    .eq("status", "active")
    .or(`session_refreshed_at.is.null,session_refreshed_at.lt.${cutoff}`);
  const rows = (data as Row[]) ?? [];

  for (const acct of rows) {
    const url = homeUrl(acct.platform, acct.instance_url);
    if (!url || !acct.enc_access_token) {
      out.skipped++;
      continue;
    }
    out.checked++;
    try {
      const cookies = parseCookies(decryptSecret(acct.enc_access_token));
      const res = await refreshCookieSession({ platform: acct.platform, homeUrl: url, cookies });
      if (!res.loggedIn) {
        // Session is dead — flag it so the UI prompts a reconnect (and posting
        // stops until fresh cookies are exported).
        await supabase.from("sp_account").update({ status: "token_expired" }).eq("id", acct.id);
        out.expired++;
        continue;
      }
      await supabase
        .from("sp_account")
        .update({
          enc_access_token: encryptSecret(JSON.stringify(res.cookies)),
          session_refreshed_at: new Date().toISOString(),
        })
        .eq("id", acct.id);
      out.refreshed++;
    } catch (err) {
      // Transient failure (navigation error / temporary block) — leave the
      // account untouched and retry next run. Never flag token_expired on a
      // non-login error, or a blip would nuke a live session.
      console.warn(
        `[session-refresh] ${acct.platform} ${acct.id} failed:`,
        err instanceof Error ? err.message : err,
      );
      out.skipped++;
    }
  }
  return out;
}
