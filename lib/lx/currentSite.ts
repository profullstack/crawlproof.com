// Site-picker scoping helper for the agency tier.
//
// Reads `current_site_id` from cookies, validates that the signed-in
// user owns that site, returns the site row. Falls back to the user's
// first site when the cookie is missing or stale.
//
// Every site-scoped route in app/(app)/autoblog (and eventually
// app/(app)/social) should call one of these helpers — never query
// lx_site by user_id directly, or we'll pick a random site when the
// user owns multiple.

import "server-only";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export const CURRENT_SITE_COOKIE = "current_site_id";

export type SiteSummary = {
  id: string;
  domain: string;
  name: string | null;
  status: string;
};

// All sites the signed-in user owns. Empty array if none.
export async function listUserSites(): Promise<SiteSummary[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("lx_site")
    .select("id, domain, name, status")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  return (data ?? []) as SiteSummary[];
}

// Resolve the active site for the signed-in user:
//   1. Read current_site_id from cookies.
//   2. If present and owned by the user, return it.
//   3. Otherwise return the user's first site (oldest-created).
//   4. If the user has no sites, return null.
//
// Returns null when:
//   - Not signed in.
//   - User has no sites at all (new user pre-onboarding).
export async function getCurrentSite<T extends string = "*">(
  columns: T = "*" as T,
): Promise<Record<string, unknown> | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const cookieStore = await cookies();
  const cookieId = cookieStore.get(CURRENT_SITE_COOKIE)?.value;

  if (cookieId) {
    const { data } = await supabase
      .from("lx_site")
      .select(columns)
      .eq("id", cookieId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (data) return data as Record<string, unknown>;
    // Cookie names a site the user doesn't own (deleted, transferred,
    // or someone messing with cookies). Fall through to first-site.
  }

  const { data: first } = await supabase
    .from("lx_site")
    .select(columns)
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return (first as Record<string, unknown> | null) ?? null;
}

// Server-action / route-handler helper that writes the cookie.
// Caller is responsible for `revalidatePath` or `router.refresh()`
// after this resolves.
export async function setCurrentSite(siteId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(CURRENT_SITE_COOKIE, siteId, {
    path: "/",
    sameSite: "lax",
    httpOnly: false, // the client also reads this when picking
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365, // a year — site selection is sticky
  });
}
