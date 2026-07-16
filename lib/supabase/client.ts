import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client. Reads the session from the same cookies the
// SSR client (lib/supabase/server.ts) writes, so it's authenticated as the
// signed-in user — which lets Realtime subscriptions enforce RLS per user.
// Reads the NEXT_PUBLIC_ env vars directly (both are inlined into the client
// bundle) rather than importing the shared server env module. Memoized so
// repeated calls share one client (and one websocket).
let cached: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  if (cached) return cached;
  cached = createBrowserClient<any>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  );
  return cached;
}
