// Reading a project's tracker numbers as an API caller rather than as a
// signed-in dashboard user.
//
// The dashboard's own stats route is session-authed (`requireProjectAccess`),
// which a CLI holding a bearer token cannot satisfy. The panels themselves are
// already pure reads over the service client, so this is only the two things
// the route needs on top: finding which of the caller's projects was meant,
// and choosing what a "did my post land" answer consists of.

import type { SupabaseClient } from "@supabase/supabase-js";

import { hostOf } from "@/lib/ads/slots";
import { fetchPanels, type ListItem, type PanelKey, type PanelPayload } from "@/lib/tracker/panels";
import type { TrackerRange } from "@/lib/tracker/ranges";
import type { TrackerKind } from "@/lib/tracker/humans";

type Sb = SupabaseClient;

export type ProjectRow = { id: string; name: string; url: string; tracker_enabled?: boolean | null };

/**
 * The panels that answer "is anybody arriving, and from where".
 *
 * Deliberately not every panel: a CLI answer people read in a terminal is the
 * sources, the pages and the shape over time. Devices and browsers are a
 * different question and cost another query each.
 */
export const STATS_PANELS: PanelKey[] = ["series", "sources", "pages", "referrers"];

export type ResolveResult =
  | { ok: true; project: ProjectRow }
  | { ok: false; status: number; error: string };

/**
 * Which project the caller means: a uuid, a hostname, or their only one.
 *
 * Always scoped by `owner_id`, so a token cannot read a project it does not
 * own even if it guesses the id. A hostname is matched the way the ads API
 * matches it, so `crawlproof stats nichedb.dev` and `crawlproof slots create
 * nichedb.dev` mean the same site.
 */
export async function listProjects(
  sb: Sb,
  userId: string,
): Promise<{ ok: true; projects: ProjectRow[] } | { ok: false; status: number; error: string }> {
  const { data, error } = await sb
    .from("projects")
    .select("id, name, url, tracker_enabled")
    .eq("owner_id", userId)
    .is("archived_at", null);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, projects: (data ?? []) as ProjectRow[] };
}

export async function resolveProject(sb: Sb, userId: string, site: string | null): Promise<ResolveResult> {
  const listed = await listProjects(sb, userId);
  if (!listed.ok) return listed;

  const projects = listed.projects;
  if (!projects.length) return { ok: false, status: 404, error: "No projects on this account yet." };

  if (!site) {
    if (projects.length === 1) return { ok: true, project: projects[0] as ProjectRow };
    return {
      ok: false,
      status: 400,
      error: `Which site? ${projects.map((p) => p.name).join(", ")}`,
    };
  }

  const wanted = site.trim();
  const byId = projects.find((p) => p.id === wanted);
  if (byId) return { ok: true, project: byId };

  // A bare hostname is not a URL, so try it as one before giving up on it.
  const host = hostOf(wanted) ?? hostOf(`https://${wanted}`);
  if (host) {
    const byHost = projects.find((p) => {
      const projectHost = hostOf(p.url ?? "");
      return projectHost !== null && projectHost === host;
    });
    if (byHost) return { ok: true, project: byHost };
  }

  const byName = projects.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (byName) return { ok: true, project: byName };

  return { ok: false, status: 404, error: `No project for "${site}". Yours: ${projects.map((p) => p.name).join(", ")}` };
}

export type StatsAnswer = {
  project: { id: string; name: string; url: string };
  range: string;
  who: string;
  totals: { visitors: number; pageviews: number };
  sources: ListItem[];
  referrers: ListItem[];
  pages: ListItem[];
};

const asList = (payload: PanelPayload | undefined): ListItem[] => (Array.isArray(payload) ? payload : []);

/** Sum a series payload's points into the two numbers a summary line needs. */
export function totalsFromSeries(payload: PanelPayload | undefined): { visitors: number; pageviews: number } {
  if (!payload || Array.isArray(payload)) return { visitors: 0, pageviews: 0 };
  const points = (payload as { points?: Record<string, unknown>[] }).points ?? [];
  let visitors = 0;
  let pageviews = 0;
  for (const point of points) {
    visitors += Number(point.visitors ?? point.humans ?? 0) || 0;
    pageviews += Number(point.pageviews ?? 0) || 0;
  }
  return { visitors, pageviews };
}

export async function projectStats(
  sb: Sb,
  project: ProjectRow,
  range: TrackerRange,
  kind: TrackerKind | null,
  who: string,
): Promise<StatsAnswer> {
  const panels = await fetchPanels(sb, project.id, STATS_PANELS, range, kind);
  return {
    project: { id: project.id, name: project.name, url: project.url },
    range: range.key,
    who,
    totals: totalsFromSeries(panels.series),
    sources: asList(panels.sources),
    referrers: asList(panels.referrers),
    pages: asList(panels.pages),
  };
}
