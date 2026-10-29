// crawlproof's own /dashboard/fleet runs the same @profullstack/fleetbar
// server handler as w3bs.org/fleet and threatcrush.com/fleet, with crawlproof's
// own partner token (name "crawlproof", env CRAWLPROOF_UPTIME_TOKEN). The only
// difference: the "upstream" call to /api/uptime/v1 is served in process
// instead of over the network, so the panel behaves identically (same auth,
// same routes, same errors) without a loopback through nginx.
import { createFleetbarHandler, type FleetbarUser } from "@profullstack/fleetbar/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleUptimeApi, supabaseUptimeStore } from "./uptime-partner";
import { isPlaceholderEmail, supabaseCoinpayStore } from "./coinpay-signin";

const UPSTREAM = "https://crawlproof.internal";
const PREFIX = "/api/uptime/v1/";

/** A fetch that answers /api/uptime/v1/* with the partner API in this process. */
export function inProcessUptimeFetch(service: () => SupabaseClient): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== UPSTREAM || !url.pathname.startsWith(PREFIX)) return new Response(null, { status: 404 });
    const segments = url.pathname.slice(PREFIX.length).split("/").filter(Boolean);
    const req = new Request(url, { method: init?.method, headers: init?.headers, body: init?.body ?? undefined });
    return handleUptimeApi(req, segments, { store: supabaseUptimeStore(service()) });
  }) as typeof fetch;
}

type SessionUser = { id: string; email?: string | null; email_confirmed_at?: string | null };

/** The fleetbar user for a crawlproof session: a confirmed real email, plus the CoinPay sub when linked. */
export async function fleetbarUserFor(user: SessionUser | null, service: () => SupabaseClient): Promise<FleetbarUser | null> {
  if (!user) return null;
  const identity = await supabaseCoinpayStore(service()).identityByUser(user.id).catch(() => null);
  const realEmail = !!user.email && !isPlaceholderEmail(user.email);
  return {
    email: realEmail ? user.email! : undefined,
    emailVerified: realEmail && !!user.email_confirmed_at,
    coinpaySub: identity?.coinpay_sub ?? null,
  };
}

export function crawlproofFleetbarHandler(opts: {
  getSessionUser: () => Promise<SessionUser | null>;
  service: () => SupabaseClient;
}) {
  return createFleetbarHandler({
    crawlproofUrl: UPSTREAM,
    // Read at request time through a non-literal key: Next inlines process.env.NAME at build.
    token: () => (process.env as Record<string, string | undefined>)["CRAWLPROOF_UPTIME_TOKEN"],
    getUser: async () => fleetbarUserFor(await opts.getSessionUser(), opts.service),
    fetch: inProcessUptimeFetch(opts.service),
  });
}
