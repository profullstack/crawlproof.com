"use client";

import { useEffect } from "react";
import { SOURCE_COOKIE, SOURCE_COOKIE_DAYS, VISITOR_COOKIE, parseSource } from "@/lib/funnel-shared";

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function setCookie(name: string, value: string, days: number) {
  const maxAge = days * 24 * 60 * 60;
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax; Secure`;
}

/** Make sure this browser has a visitor id and remembers a `?src=` it arrived with. */
export function ensureFunnelCookies(): { visitorId: string; source: string | null } {
  let visitorId = readCookie(VISITOR_COOKIE);
  if (!visitorId) {
    visitorId = crypto.randomUUID();
    setCookie(VISITOR_COOKIE, visitorId, 365);
  }
  const fromUrl = parseSource(new URLSearchParams(window.location.search).get("src"));
  if (fromUrl) setCookie(SOURCE_COOKIE, fromUrl, SOURCE_COOKIE_DAYS);
  return { visitorId, source: fromUrl ?? parseSource(readCookie(SOURCE_COOKIE)) };
}

/**
 * Sets the funnel cookies on any page; on a report page (token given) also
 * records report_viewed. Renders nothing.
 */
export function FunnelBeacon({ token }: { token?: string }) {
  useEffect(() => {
    let ctx: { visitorId: string; source: string | null };
    try {
      ctx = ensureFunnelCookies();
    } catch {
      return;
    }
    if (!token) return;
    void fetch("/api/funnel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "report_viewed",
        token,
        visitor_id: ctx.visitorId,
        source: ctx.source,
      }),
      keepalive: true,
    }).catch(() => {});
  }, [token]);
  return null;
}
