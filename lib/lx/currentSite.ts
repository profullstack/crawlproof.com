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

// Returns project IDs the user is a member of (via invitation, not ownership).
async function memberProjectIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("project_members")
    .select("project_id")
    .eq("user_id", userId);
  return (data ?? []).map((r: { project_id: string }) => r.project_id);
}

// Builds a filter string for "projects the user can access" — owner or member.
function accessFilter(userId: string, memberIds: string[]): string | null {
  if (memberIds.length === 0) return null;
  return `owner_id.eq.${userId},id.in.(${memberIds.join(",")})`;
}

// All projects the signed-in user owns or is a member of, with an autoblog badge.
export async function listUserProjects(): Promise<ProjectSummary[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const memberIds = await memberProjectIds(supabase, user.id);
  const filter = accessFilter(user.id, memberIds);

  let query = supabase
    .from("projects")
    .select("id, name, url, lx_site(status)")
    .order("created_at", { ascending: true });
  query = filter ? query.or(filter) : query.eq("owner_id", user.id);
  const { data } = await query;

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
  //
  // We also surface the *real* lx_site.id under `lx_site_id` because the
  // worker enqueue layer keys on it directly (lx_site, lx_keyword,
  // lx_article rows are owned by lx_site.id, not by the project). Routes
  // that hit `enqueueArticleGenerate`/etc must use `lx_site_id`, not `id`.
  const site = (project.lx_site ?? {}) as Record<string, unknown>;
  const lxSiteId =
    typeof site.id === "string" && site.id.length > 0 ? site.id : null;
  return {
    ...site,
    id: project.id,
    project_id: project.id,
    lx_site_id: lxSiteId,
    name: project.name ?? site.name ?? null,
    url: project.url ?? site.url ?? null,
  };
}

// Fetch a specific project (and its autoblog config) by id, scoped to
// the signed-in user. Mirrors getCurrentProject's shape so the same
// normalize logic applies. Use this from project sub-tab pages
// (/projects/[id]/autoblog, /projects/[id]/social, …) where the id
// comes from the URL rather than the picker cookie.
export async function getProjectById(
  projectId: string,
  opts: { siteColumns?: string; projectColumns?: string } = {},
): Promise<
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

  const { data } = await supabase
    .from("projects")
    .select(`${select}, owner_id`)
    .eq("id", projectId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  if (row.owner_id !== user.id) {
    const { data: membership } = await supabase
      .from("project_members")
      .select("id")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return null;
  }
  return normalizeProject(row);
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

  const [cookieStore, memberIds] = await Promise.all([
    cookies(),
    memberProjectIds(supabase, user.id),
  ]);
  const filter = accessFilter(user.id, memberIds);
  const cookieId = cookieStore.get(CURRENT_SITE_COOKIE)?.value;

  if (cookieId) {
    // The cookie may hold a project_id (new) or an lx_site.id (legacy).
    // Try project first; if no hit, look up the project_id from lx_site.
    let q = supabase.from("projects").select(select).eq("id", cookieId);
    q = filter ? q.or(filter) : q.eq("owner_id", user.id);
    const { data: byProject } = await q.maybeSingle();
    if (byProject) return normalizeProject(byProject as unknown as Record<string, unknown>);

    const { data: viaSite } = await supabase
      .from("lx_site")
      .select("project_id")
      .eq("id", cookieId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (viaSite?.project_id) {
      let hq = supabase.from("projects").select(select).eq("id", viaSite.project_id);
      hq = filter ? hq.or(filter) : hq.eq("owner_id", user.id);
      const { data: hopped } = await hq.maybeSingle();
      if (hopped) return normalizeProject(hopped as unknown as Record<string, unknown>);
    }
  }

  let fallback = supabase
    .from("projects")
    .select(select)
    .order("created_at", { ascending: true })
    .limit(1);
  fallback = filter ? fallback.or(filter) : fallback.eq("owner_id", user.id);
  const { data: first } = await fallback.maybeSingle();
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

// Server-action / route-handler helper that verifies the signed-in user owns
// or is a member of the given project. Returns the user id, an isOwner flag,
// and the authenticated supabase client so callers can make further queries.
export async function requireProjectAccess(projectId: string): Promise<
  | { ok: false; error: string }
  | {
      ok: true;
      userId: string;
      userEmail: string | null;
      isOwner: boolean;
      supabase: Awaited<ReturnType<typeof createClient>>;
    }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: project } = await supabase
    .from("projects")
    .select("id, owner_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { ok: false, error: "Not found." };

  const isOwner = (project as { owner_id: string }).owner_id === user.id;
  if (!isOwner) {
    const { data: membership } = await supabase
      .from("project_members")
      .select("id")
      .eq("project_id", projectId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return { ok: false, error: "Not found." };
  }

  return { ok: true, userId: user.id, userEmail: user.email ?? null, isOwner, supabase };
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
