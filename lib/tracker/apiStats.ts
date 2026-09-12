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
import {
  fetchPanel,
  fetchPanels,
  resolveDays,
  type ListItem,
  type PanelKey,
  type PanelPayload,
} from "@/lib/tracker/panels";
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

/** One bucket of the series, trimmed to what a client can plot or score. */
export type StatsPoint = {
  date: string;
  pageviews: number;
  humans: number;
  bots: number;
  ai: number;
};

export type StatsAnswer = {
  project: { id: string; name: string; url: string };
  range: string;
  who: string;
  totals: { visitors: number; pageviews: number };
  sources: ListItem[];
  referrers: ListItem[];
  pages: ListItem[];
  /**
   * The shape over time, present only with `detail`. It is what the totals were
   * summed from, so asking for it costs nothing extra.
   */
  series?: StatsPoint[];
  /**
   * Humans against bots over the same window, unfiltered.
   *
   * A filtered answer cannot carry this: asking for `who=humans` filters the
   * RPC to `p_kind = 'human'`, so its bot column is zero by construction rather
   * than by observation, and a share computed from it would read 100% human on
   * a site that is 99% crawler. So this is a second, unfiltered read — skipped
   * when the caller already asked for everything, where the main series IS it.
   */
  mix?: { humans: number; bots: number; ai: number; events: number };
};

const asList = (payload: PanelPayload | undefined): ListItem[] => (Array.isArray(payload) ? payload : []);

const count = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** The series payload as plottable points. Empty for a list payload or nothing. */
export function seriesPoints(payload: PanelPayload | undefined): StatsPoint[] {
  if (!payload || Array.isArray(payload)) return [];
  const points = (payload as { points?: Record<string, unknown>[] }).points ?? [];
  return points.map((p) => ({
    date: String(p.date ?? ""),
    pageviews: count(p.pageviews),
    humans: count(p.humans),
    bots: count(p.bots),
    ai: count(p.ai),
  }));
}

/** Sum a series payload into the human / bot split. */
export function mixFromSeries(payload: PanelPayload | undefined): {
  humans: number;
  bots: number;
  ai: number;
  events: number;
} {
  const mix = { humans: 0, bots: 0, ai: 0, events: 0 };
  if (!payload || Array.isArray(payload)) return mix;
  for (const p of (payload as { points?: Record<string, unknown>[] }).points ?? []) {
    mix.humans += count(p.humans);
    mix.bots += count(p.bots);
    mix.ai += count(p.ai);
    mix.events += count(p.events);
  }
  return mix;
}

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
  /** Add the series and the unfiltered human / bot mix. One extra RPC at most. */
  detail = false,
): Promise<StatsAnswer> {
  const [panels, mixSeries] = await Promise.all([
    fetchPanels(sb, project.id, STATS_PANELS, range, kind),
    // Only when the answer is filtered: at kind null the main series already is
    // the unfiltered one, and a second identical query would be a second query.
    detail && kind !== null
      ? fetchPanel(sb, project.id, "series", range, await resolveDays(sb, project.id, range), null)
      : Promise.resolve(undefined),
  ]);

  const answer: StatsAnswer = {
    project: { id: project.id, name: project.name, url: project.url },
    range: range.key,
    who,
    totals: totalsFromSeries(panels.series),
    sources: asList(panels.sources),
    referrers: asList(panels.referrers),
    pages: asList(panels.pages),
  };
  if (!detail) return answer;

  return {
    ...answer,
    series: seriesPoints(panels.series),
    mix: mixFromSeries(kind === null ? panels.series : mixSeries),
  };
}
