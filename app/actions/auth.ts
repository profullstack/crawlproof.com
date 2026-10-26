"use server";

import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { validateProfile, saveSignupProfile, type ProfileField } from "@profullstack/profile";
import { profileStore } from "@/lib/profile";

type Ok<T = Record<string, unknown>> = { ok: true } & T;
type Err = { ok: false; error: string; fieldErrors?: Partial<Record<ProfileField, string>> };

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
// "check your inbox" state). The @profullstack/profile fields (first/last
// name required, company domain, job title, LinkedIn optional) are validated
// before the user is created and stored on public.profiles right after.
export async function signUpWithPassword(input: {
  email: string;
  password: string;
  redirectTo?: string;
  profile?: Partial<Record<ProfileField, string>>;
}): Promise<(Ok<{ needsConfirmation: boolean }>) | Err> {
  const fields = { ...(input.profile ?? {}), email: input.email };
  const check = validateProfile(fields);
  if (!check.ok) {
    return { ok: false, error: "Some fields need fixing.", fieldErrors: check.errors };
  }
  const p = check.profile;
  const supabase = await createClient();
  const next = input.redirectTo ?? "/dashboard";
  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      emailRedirectTo: `${siteOrigin()}/auth/callback?next=${encodeURIComponent(next)}`,
      data: {
        full_name: [p.first_name, p.last_name].filter(Boolean).join(" "),
        first_name: p.first_name,
        last_name: p.last_name,
        company_domain: p.company_domain ?? null,
        job_title: p.job_title ?? null,
        linkedin_url: p.linkedin_url ?? null,
      },
    },
  });
  if (error) return { ok: false, error: error.message };
  // An address that is already registered comes back as a stand-in user with
  // no identities; never write a profile for it.
  if (data.user && (data.user.identities?.length ?? 0) > 0) {
    try {
      await saveSignupProfile(profileStore(), data.user.id, fields, { email: data.user.email });
    } catch (e) {
      // The account exists; the fields are also in user metadata and can be
      // filled in from Settings. Do not fail the signup over them.
      console.error("[signup] profile save failed", e);
    }
  }
  return { ok: true, needsConfirmation: !data.session };
}

// Request a password-reset email. Supabase fires the (branded) recovery
// template; the link drops the user on /auth/callback which exchanges the
// code for a session and then redirects to /auth/reset.
export async function requestPasswordReset(input: {
  email: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(input.email, {
    redirectTo: `${siteOrigin()}/auth/callback?next=${encodeURIComponent("/auth/reset")}`,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// Set a new password for the currently-signed-in user — called from the
// /auth/reset form after the recovery callback has set a session cookie.
export async function updatePassword(input: {
  password: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: input.password });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
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
