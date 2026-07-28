import { createBrowserSupabase } from "@profullstack/stack/supabase";

// Browser-side Supabase client. Reads the session from the same cookies the
// SSR client (lib/supabase/server.ts) writes, so it's authenticated as the
// signed-in user — which lets Realtime subscriptions enforce RLS per user.
// Reads the NEXT_PUBLIC_ env vars directly (both are inlined into the client
// bundle) rather than importing the shared server env module. The ssr browser
// client is a singleton, so repeated calls share one client (one websocket).
export function createClient() {
  return createBrowserSupabase();
}
