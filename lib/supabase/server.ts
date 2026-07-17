import { cookies } from "next/headers";
import { createServerSupabase } from "@profullstack/stack/supabase";
import { env } from "@/lib/env";

export function createClient() {
  return createServerSupabase(cookies(), {
    url: env.supabaseUrl,
    anonKey: env.supabaseAnonKey,
  });
}
