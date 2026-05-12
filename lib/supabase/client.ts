"use client";
import { createBrowserClient } from "@supabase/ssr";
import { env } from "@/lib/env";

export function createClient() {
  return createBrowserClient<any>(env.supabaseUrl, env.supabaseAnonKey);
}
