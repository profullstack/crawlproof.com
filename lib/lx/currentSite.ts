// Project-picker scoping helper.
//
// After the projects+lx_site unification, every "domain I'm managing"
// is a `projects` row. `lx_site` is the optional autoblog config that
// hangs off a project (1:1). This helper resolves the active project
// from a cookie and lets callers pull project + autoblog columns in
// one query.
//
// Cookie name stays `current_site_id` so existing browser sessions
// don't lose their selection; the resolver also accepts a legacy
// lx_site.id and transparently maps it to its project_id.

import "server-only";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export const CURRENT_SITE_COOKIE = "current_site_id";

export type ProjectSummary = {
  id: string;
  name: string;
  url: string;
  domain: string;
  hasAutoblog: boolean;
  autoblogStatus: string | null;
};

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// All projects the signed-in user owns, with an autoblog badge.
export async function listUserProjects(): Promise<ProjectSummary[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data } = await supabase
    .from("projects")
    .select("id, name, url, lx_site(status)")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: true });

  return ((data ?? []) as Array<{
    id: string;
    name: string;
    url: string;
    lx_site: { status: string } | { status: string }[] | null;
  }>).map((p) => {
    const site = Array.isArray(p.lx_site) ? p.lx_site[0] ?? null : p.lx_site;
    return {
      id: p.id,
      name: p.name,
      url: p.url,
      domain: extractDomain(p.url),
      hasAutoblog: !!site,
      autoblogStatus: site?.status ?? null,
    };
  });
}

// Backwards-compatible alias used by callers that still think in "sites".
export const listUserSites = listUserProjects;
export type SiteSummary = ProjectSummary;

// Resolve the active project for the signed-in user. The returned row
// merges columns from `projects` with the columns the caller requests
// from `lx_site` (passed via `siteColumns`). When the user has no
// autoblog config yet, the lx_site columns come back as null.
//
// `columns` exists for back-compat with getCurrentSite — it selects
// columns from lx_site only. New callers should use the explicit
// `siteColumns` + `projectColumns` form via getCurrentProject.
export async function getCurrentSite<T extends string = "*">(
  columns: T = "*" as T,
): Promise<Record<string, unknown> | null> {
  const project = await getCurrentProject({
    siteColumns: columns,
    projectColumns: "id, name, url",
  });
  if (!project) return null;
  // Existing callers expect a single flat object that *looks like* an
  // lx_site row. Merge the lx_site fields up and override id/name/url
  // with the project's so the row is project-keyed end-to-end.
  const site = (project.lx_site ?? {}) as Record<string, unknown>;
  return {
    ...site,
    id: project.id,
    project_id: project.id,
    name: project.name ?? site.name ?? null,
    url: project.url ?? site.url ?? null,
  };
}

export async function getCurrentProject(opts: {
  siteColumns?: string;
  projectColumns?: string;
}): Promise<
  | (Record<string, unknown> & { id: string; lx_site: Record<string, unknown> | null })
  | null
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const projectColumns = opts.projectColumns ?? "id, name, url";
  const siteColumns = opts.siteColumns ?? "*";
  const select = `${projectColumns}, lx_site(${siteColumns})`;

  const cookieStore = await cookies();
  const cookieId = cookieStore.get(CURRENT_SITE_COOKIE)?.value;

  if (cookieId) {
    // The cookie may hold a project_id (new) or an lx_site.id (legacy).
    // Try project first; if no hit, look up the project_id from lx_site.
    const { data: byProject } = await supabase
      .from("projects")
      .select(select)
      .eq("id", cookieId)
      .eq("owner_id", user.id)
      .maybeSingle();
    if (byProject) return normalizeProject(byProject as unknown as Record<string, unknown>);

    const { data: viaSite } = await supabase
      .from("lx_site")
      .select("project_id")
      .eq("id", cookieId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (viaSite?.project_id) {
      const { data: hopped } = await supabase
        .from("projects")
        .select(select)
        .eq("id", viaSite.project_id)
        .eq("owner_id", user.id)
        .maybeSingle();
      if (hopped) return normalizeProject(hopped as unknown as Record<string, unknown>);
    }
  }

  const { data: first } = await supabase
    .from("projects")
    .select(select)
    .eq("owner_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return first ? normalizeProject(first as unknown as Record<string, unknown>) : null;
}

function normalizeProject(
  row: Record<string, unknown>,
): Record<string, unknown> & { id: string; lx_site: Record<string, unknown> | null } {
  // Supabase joins return the child as an object when there's a unique
  // FK and as an array otherwise; lx_site_project_id_unique makes it
  // 1:1 but we defend against both shapes for safety.
  const raw = row.lx_site;
  const lx_site = Array.isArray(raw)
    ? (raw[0] as Record<string, unknown>) ?? null
    : ((raw as Record<string, unknown>) ?? null);
  return { ...row, id: row.id as string, lx_site };
}

// Server-action / route-handler helper that writes the cookie. The
// argument is the active project_id (or, for legacy callers, an
// lx_site.id; the resolver above handles either).
export async function setCurrentSite(projectId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(CURRENT_SITE_COOKIE, projectId, {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export const setCurrentProject = setCurrentSite;
