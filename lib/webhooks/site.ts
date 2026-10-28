// Which autoblog site a webhooks call is about. Endpoints are owned by an
// lx_site (see lib/webhooks/hub.ts); the caller's account must own the site.
//
// `site` may be the lx_site id, its project id, or its domain. With no `site`
// an account that has exactly one autoblog site gets that one.

import type { SupabaseClient } from "@supabase/supabase-js";

export type OwnedSite = { id: string; domain: string; project_id: string; webhook_endpoint_id: string | null };

export type SiteResult =
  | { ok: true; site: OwnedSite }
  | { ok: false; status: number; error: string };

const normalize = (s: string) =>
  s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

export async function resolveOwnedSite(
  sb: SupabaseClient<any>,
  userId: string,
  site: string | null | undefined,
): Promise<SiteResult> {
  const { data, error } = await sb
    .from("lx_site")
    .select("id, domain, project_id, webhook_endpoint_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) return { ok: false, status: 500, error: error.message };
  const sites = (data as OwnedSite[] | null) ?? [];
  if (!sites.length) return { ok: false, status: 404, error: "No autoblog sites on this account yet." };
  const wanted = (site ?? "").trim();
  if (!wanted) {
    if (sites.length === 1) return { ok: true, site: sites[0] };
    return {
      ok: false,
      status: 400,
      error: `Which site? Pass ?site=<domain or id>: ${sites.map((s) => s.domain).join(", ")}`,
    };
  }
  const hit =
    sites.find((s) => s.id === wanted || s.project_id === wanted) ??
    sites.find((s) => normalize(s.domain ?? "") === normalize(wanted));
  if (!hit) return { ok: false, status: 404, error: `No autoblog site "${wanted}" on this account.` };
  return { ok: true, site: hit };
}
