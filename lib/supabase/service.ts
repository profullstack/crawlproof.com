import { createClient as createSb, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

// We don't generate Supabase Database types in this repo; type the client as
// permissive so .from(...) returns plain row shapes.
type DB = any;

let cached: SupabaseClient<DB> | null = null;

export function serviceClient(): SupabaseClient<DB> {
  if (cached) return cached;
  cached = createSb<DB>(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}
