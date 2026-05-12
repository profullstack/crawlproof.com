"use server";

import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

type Ok<T = Record<string, unknown>> = { ok: true } & T;
type Err = { ok: false; error: string };

function siteOrigin(): string {
  return env.siteUrl.replace(/\/$/, "");
}

// Email + password sign-in. Cookies set server-side by Supabase SSR.
export async function signInWithPassword(input: {
  email: string;
  password: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// Email + password sign-up. Returns `needsConfirmation: true` when Supabase
// requires email verification before issuing a session (caller shows the
// "check your inbox" state).
export async function signUpWithPassword(input: {
  email: string;
  password: string;
  redirectTo?: string;
}): Promise<(Ok<{ needsConfirmation: boolean }>) | Err> {
  const supabase = await createClient();
  const next = input.redirectTo ?? "/dashboard";
  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      emailRedirectTo: `${siteOrigin()}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, needsConfirmation: !data.session };
}

// Start a Google OAuth flow. Returns the URL the client should redirect to.
// Supabase handles the round-trip; our /auth/callback route exchanges the
// code for a session cookie.
export async function startGoogleOAuth(input: {
  redirectTo?: string;
}): Promise<Ok<{ url: string }> | Err> {
  const supabase = await createClient();
  const next = input.redirectTo ?? "/dashboard";
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${siteOrigin()}/auth/callback?next=${encodeURIComponent(next)}`,
      // Tell the SDK not to redirect on the server — we want the URL back.
      skipBrowserRedirect: true,
    },
  });
  if (error || !data?.url) {
    return { ok: false, error: error?.message ?? "Could not start Google sign-in." };
  }
  return { ok: true, url: data.url };
}
