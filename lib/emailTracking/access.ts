// Email tracking for a bearer-token caller: which projects the token's user
// can reach, in what role, and what each project's tracking looks like from
// outside. The dashboard tab answers the same questions through a session
// (requireProjectAccess); this is the same rule for the API, the CLI and the
// TUI, which only have a crp_ token.
//
// Roles follow requireProjectAccess: the owner and org owners/members may
// change tracking, a project member with role "viewer" may only look, and a
// viewer never sees the secret.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmailEventType } from "@/lib/emailTracking/core";
import type { TrackingRow } from "@/lib/emailTracking/store";

export type ProjectRole = "owner" | "member" | "viewer";

export type AccessibleProject = {
  id: string;
  name: string;
  url: string | null;
  role: ProjectRole;
};

type ProjectRecord = { id: string; name: string | null; url: string | null };

const RANK: Record<ProjectRole, number> = { owner: 3, member: 2, viewer: 1 };

/** Every project the user can reach, the strongest role winning. */
export async function accessibleProjects(sb: SupabaseClient, userId: string): Promise<AccessibleProject[]> {
  const found = new Map<string, AccessibleProject>();
  const add = (rows: ProjectRecord[] | null, role: ProjectRole) => {
    for (const row of rows ?? []) {
      const current = found.get(row.id);
      if (current && RANK[current.role] >= RANK[role]) continue;
      found.set(row.id, { id: row.id, name: row.name ?? "", url: row.url ?? null, role });
    }
  };

  const owned = await sb.from("projects").select("id, name, url").eq("owner_id", userId);
  add(owned.data as ProjectRecord[] | null, "owner");

  const memberships = await sb.from("project_members").select("project_id, role").eq("user_id", userId);
  const byRole = new Map<ProjectRole, string[]>();
  for (const m of (memberships.data as { project_id: string; role: string | null }[] | null) ?? []) {
    const role: ProjectRole = m.role === "viewer" ? "viewer" : "member";
    byRole.set(role, [...(byRole.get(role) ?? []), m.project_id]);
  }
  for (const [role, ids] of byRole) {
    if (!ids.length) continue;
    const rows = await sb.from("projects").select("id, name, url").in("id", ids);
    add(rows.data as ProjectRecord[] | null, role);
  }

  const orgs = await sb.from("organization_members").select("organization_id").eq("user_id", userId).in("role", ["owner", "member"]);
  const orgIds = ((orgs.data as { organization_id: string }[] | null) ?? []).map((o) => o.organization_id);
  if (orgIds.length) {
    const rows = await sb.from("projects").select("id, name, url").in("organization_id", orgIds);
    add(rows.data as ProjectRecord[] | null, "member");
  }

  return [...found.values()].sort((a, b) => siteOf(a).localeCompare(siteOf(b)));
}

/** The project's hostname without www, or its name when it has no URL. */
export function siteOf(project: Pick<AccessibleProject, "name" | "url">): string {
  if (project.url) {
    try {
      return new URL(project.url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      // fall through to the name
    }
  }
  return project.name.trim().toLowerCase();
}

/** A hostname out of whatever was typed: "moshcode.sh", "https://www.moshcode.sh/x". */
export function normalizeSiteRef(ref: string): string {
  const raw = ref.trim().toLowerCase();
  if (!raw) return "";
  try {
    return new URL(/^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
  } catch {
    return raw;
  }
}

/** A project by id, hostname or name. Null when none matches or the match is ambiguous. */
export function pickProject(projects: AccessibleProject[], ref: string): AccessibleProject | null {
  const byId = projects.find((p) => p.id === ref.trim());
  if (byId) return byId;
  const host = normalizeSiteRef(ref);
  const matches = projects.filter((p) => siteOf(p) === host || p.name.trim().toLowerCase() === ref.trim().toLowerCase());
  return matches.length === 1 ? (matches[0] as AccessibleProject) : null;
}

export type EventCounts = Record<EmailEventType, number>;

export const emptyCounts = (): EventCounts => ({ open: 0, click: 0, unsubscribe: 0 });

/** Events per project since `since`, counted by type. Machine opens and clicks are left out. */
export async function eventCounts(sb: SupabaseClient, projectIds: string[], since: string): Promise<Record<string, EventCounts>> {
  const out: Record<string, EventCounts> = {};
  for (const id of projectIds) out[id] = emptyCounts();
  if (!projectIds.length) return out;
  const { data } = await sb
    .from("email_tracking_events")
    .select("project_id, type, machine")
    .in("project_id", projectIds)
    .gte("at", since)
    .limit(50_000);
  for (const row of (data as { project_id: string; type: EmailEventType; machine: boolean }[] | null) ?? []) {
    if (row.machine && row.type !== "unsubscribe") continue;
    const counts = out[row.project_id];
    if (counts && row.type in counts) counts[row.type]++;
  }
  return out;
}

export type PublicTracking = {
  project_id: string;
  site: string;
  name: string;
  role: ProjectRole;
  tracking_id: string;
  enabled: boolean;
  enabled_at: string | null;
  secret_rotated_at: string | null;
  tracking_url: string;
  events_url: string;
  events_24h?: EventCounts;
  /** Only when asked for, and never to a viewer. */
  secret?: string;
};

export function shapeTracking(
  project: AccessibleProject,
  row: TrackingRow,
  options: { siteBase: string; counts?: EventCounts; withSecret?: boolean },
): PublicTracking {
  const base = options.siteBase.replace(/\/$/, "");
  return {
    project_id: project.id,
    site: siteOf(project),
    name: project.name,
    role: project.role,
    tracking_id: row.tracking_id,
    enabled: row.enabled,
    enabled_at: row.enabled_at,
    secret_rotated_at: row.secret_rotated_at,
    tracking_url: `${base}/t/${row.tracking_id}`,
    events_url: `${base}/api/v1/tracking/${row.tracking_id}/events`,
    ...(options.counts ? { events_24h: options.counts } : {}),
    ...(options.withSecret && project.role !== "viewer" ? { secret: row.secret } : {}),
  };
}

export const ACTIONS = ["enable", "disable", "rotate"] as const;
export type TrackingAction = (typeof ACTIONS)[number];
export const isAction = (v: string): v is TrackingAction => (ACTIONS as readonly string[]).includes(v);
